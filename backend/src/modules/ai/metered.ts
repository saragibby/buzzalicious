import { Prisma, UsageMetric } from '@prisma/client';
import { getLogger } from '../../platform/logger';
import { assertAiBudgetAvailable, type BudgetReader } from '../usage/budget';
import { emitUsage, type UsageWriter } from '../usage/usage.service';
import { getAiProvider } from './index';
import { renderPrompt } from './prompts';
import { estimateProviderCostUsd, totalTokens } from './pricing';
import type {
  AiProviderName,
  AiResult,
  AiStructuredRequest,
  AiTextRequest,
  RenderedPrompt,
} from './types';

/**
 * The metered AI call: check before, record after (ADR-0011).
 *
 * Every AI call site in the product goes through here, and nothing else writes
 * `AiGeneration` or emits `AI_TOKENS`. That is the point — two call sites exist today and
 * W5 and W6 will add more, so the correct thing has to be the easy thing rather than a
 * pattern each new caller reimplements.
 *
 * What it does, in order:
 *
 *  1. **Refuses** if the workspace is over its monthly AI cost ceiling. A single call may
 *     still overshoot the ceiling; `maxTokens` bounds that, and pre-flight estimation is
 *     not accurate enough to be worth adding to every call site.
 *  2. Makes the call.
 *  3. Writes the `AiGeneration` telemetry row **and** the `UsageEvent` in one transaction,
 *     so a charge is never recorded for work whose telemetry rolled back and vice versa.
 */

/** The client shape this needs: read a budget, write a ledger, and do both atomically. */
export interface MeteringClient extends BudgetReader, UsageWriter {
  aiGeneration: {
    create(args: { data: Prisma.AiGenerationUncheckedCreateInput }): Promise<{ id: string }>;
  };
  $transaction<R>(fn: (tx: MeteringTransactionClient) => Promise<R>): Promise<R>;
}

export interface MeteringTransactionClient extends UsageWriter {
  aiGeneration: {
    create(args: { data: Prisma.AiGenerationUncheckedCreateInput }): Promise<{ id: string }>;
  };
}

export interface MeteredAiContext {
  db: MeteringClient;
  /** The billing entity. Platform-global work uses the reserved platform workspace. */
  workspaceId: string;
  brandId?: string | null;
  postId?: string | null;
  now?: Date;
}

export interface MeteredResult<T> extends AiResult<T> {
  /** The telemetry row, so a caller can cite it when explaining a charge. */
  aiGenerationId: string;
  providerCostUsd: Prisma.Decimal | null;
}

/** Generate prose for a named purpose, metered against the workspace's AI budget. */
export async function generateTextMetered(
  ctx: MeteredAiContext,
  request: AiTextRequest,
  provider?: AiProviderName,
): Promise<MeteredResult<string>> {
  return run(
    ctx,
    request,
    provider,
    (p, prompt) => p.generateText(request, prompt),
    (text) => text,
  );
}

/** Generate schema-validated data, metered against the workspace's AI budget. */
export async function generateStructuredMetered<T>(
  ctx: MeteredAiContext,
  request: AiStructuredRequest<T>,
  provider?: AiProviderName,
): Promise<MeteredResult<T>> {
  return run(
    ctx,
    request,
    provider,
    (p, prompt) => p.generateStructured(request, prompt),
    (data) => JSON.stringify(data),
  );
}

async function run<T>(
  ctx: MeteredAiContext,
  request: AiTextRequest,
  provider: AiProviderName | undefined,
  call: (p: ReturnType<typeof getAiProvider>, prompt: RenderedPrompt) => Promise<AiResult<T>>,
  serialize: (data: T) => string,
): Promise<MeteredResult<T>> {
  const now = ctx.now ?? new Date();
  const logger = getLogger().child({ component: 'ai.metered' });

  // Before the call, not after. The fuse exists to stop spend, not to report it.
  await assertAiBudgetAvailable(ctx.db, ctx.workspaceId, now);

  const prompt = renderPrompt(request);
  const startedAt = Date.now();
  const result = await call(getAiProvider(provider), prompt);
  const responseTimeMs = Date.now() - startedAt;

  const tokens = totalTokens(result.usage);
  const providerCostUsd = estimateProviderCostUsd(result.model, result.usage);

  if (providerCostUsd === null && tokens > 0) {
    // Under-reporting is visible; a stale guessed rate is not. See pricing.ts.
    logger.warn(
      { model: result.model, provider: result.provider, tokens },
      'no published rate for this model; usage recorded with no provider cost',
    );
  }

  const aiGenerationId = await ctx.db.$transaction(async (tx) => {
    const generation = await tx.aiGeneration.create({
      data: {
        brandId: ctx.brandId ?? null,
        postId: ctx.postId ?? null,
        purpose: request.purpose,
        provider: result.provider,
        model: result.model,
        prompt: `${prompt.system}\n\n---\n\n${prompt.user}`,
        response: serialize(result.data),
        responseTimeMs,
        promptTokens: result.usage?.promptTokens ?? null,
        completionTokens: result.usage?.completionTokens ?? null,
        // Telemetry only, and a Float by W2's schema. `UsageEvent.providerCostUsd` is the
        // authoritative number; this column must never be read into billing arithmetic.
        estimatedCost: providerCostUsd === null ? null : providerCostUsd.toNumber(),
        createdAt: now,
      },
    });

    await emitUsage(tx, {
      workspaceId: ctx.workspaceId,
      brandId: ctx.brandId ?? null,
      metric: UsageMetric.AI_TOKENS,
      quantity: tokens,
      providerCostUsd,
      // Keyed on the telemetry row, which is minted per provider call.
      //
      // This is not a contradiction of the attempt-independence rule: that rule is about
      // metering a *unit of work* once (`publish:{postTargetId}`) however many attempts it
      // took, and a retried publish costs nothing extra. A retried generation is a second
      // provider call and a second real charge, so it is a second event.
      idempotencyKey: `ai:${generation.id}`,
      occurredAt: now,
      aiGenerationId: generation.id,
      metadata: {
        purpose: request.purpose,
        provider: result.provider,
        model: result.model,
        promptTokens: result.usage?.promptTokens ?? null,
        completionTokens: result.usage?.completionTokens ?? null,
      },
    });

    return generation.id;
  });

  return { ...result, aiGenerationId, providerCostUsd };
}
