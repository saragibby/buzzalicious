import { Prisma } from '@prisma/client';
import type { AiProviderName, AiUsage } from './types';

/**
 * What a provider call cost **us**.
 *
 * This is vendor cost, not price. ADR-0011 keeps the two apart deliberately: collapsing
 * them makes per-tier margin invisible at exactly the moment tiers are being set. Nothing
 * here is a customer-facing figure, and Q13 (pricing) is untouched by it.
 *
 * Rates are published list prices in USD per million tokens. They are a moving target, so:
 *
 *  - every entry carries the date it was read, and
 *  - an unknown model returns `null` rather than a guess.
 *
 * `null` is load-bearing. A missing rate must under-report cost visibly — a rollup that
 * stops growing while calls keep happening is a noticeable bug — rather than silently
 * charging a stale rate for a model nobody checked. Unknown models are logged by the
 * metered wrapper.
 *
 * Verify against the vendor's current pricing page before trusting these for anything
 * beyond the fuse. Read 2026-09-18:
 *   https://openai.com/api/pricing/  ·  https://ai.google.dev/gemini-api/docs/pricing
 */

export interface TokenRate {
  /** USD per 1,000,000 input tokens. */
  readonly inputPerMillion: string;
  /** USD per 1,000,000 output tokens. */
  readonly outputPerMillion: string;
  /** When the rate was last read from the vendor's pricing page. */
  readonly readOn: string;
}

const MILLION = new Prisma.Decimal(1_000_000);

/**
 * Keyed by the model id a provider reports back, lowercased. Providers return dated ids
 * such as `gpt-4o-mini-2024-07-18`, so lookup falls back to the longest matching prefix.
 */
const RATES: Record<string, TokenRate> = {
  'gpt-4o-mini': { inputPerMillion: '0.15', outputPerMillion: '0.60', readOn: '2026-09-18' },
  'gpt-4o': { inputPerMillion: '2.50', outputPerMillion: '10.00', readOn: '2026-09-18' },
  'gemini-2.5-flash': { inputPerMillion: '0.30', outputPerMillion: '2.50', readOn: '2026-09-18' },
  'gemini-2.0-flash': { inputPerMillion: '0.10', outputPerMillion: '0.40', readOn: '2026-09-18' },
};

/** The rate for a model id, or `null` when it is not one we have a published price for. */
export function rateFor(model: string | undefined | null): TokenRate | null {
  if (!model) return null;

  const normalized = model.trim().toLowerCase();
  const exact = RATES[normalized];
  if (exact) return exact;

  // `gpt-4o-mini-2024-07-18` -> `gpt-4o-mini`. Longest prefix wins, so `gpt-4o-mini` is
  // never priced as `gpt-4o`.
  const prefix = Object.keys(RATES)
    .filter((key) => normalized.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];

  return prefix ? RATES[prefix]! : null;
}

/**
 * Provider cost for one call, as a `Decimal`.
 *
 * Returns `null` when the model is unpriced or the provider reported no usage — the two
 * cases where any number we produced would be invented.
 */
export function estimateProviderCostUsd(
  model: string | undefined | null,
  usage: AiUsage | undefined,
): Prisma.Decimal | null {
  const rate = rateFor(model);
  if (!rate || !usage) return null;

  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;
  if (promptTokens === 0 && completionTokens === 0) return null;

  const input = new Prisma.Decimal(promptTokens).times(rate.inputPerMillion).dividedBy(MILLION);
  const output = new Prisma.Decimal(completionTokens)
    .times(rate.outputPerMillion)
    .dividedBy(MILLION);

  // Six decimal places, matching UsageEvent.providerCostUsd. A single small call rounds to
  // a fraction of a cent, and truncating it to cents would floor most calls to zero.
  return input.plus(output).toDecimalPlaces(6);
}

/** Total tokens for a call, falling back to the sum when a provider omits the total. */
export function totalTokens(usage: AiUsage | undefined): number {
  if (!usage) return 0;
  return usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
}

/** Models with a published rate. Exposed for the test that pins the table's shape. */
export function pricedModels(): string[] {
  return Object.keys(RATES);
}

export type { AiProviderName };
