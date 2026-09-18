import type { ZodType } from 'zod';
import { ExternalServiceError } from '../../platform/errors';

/**
 * Turns a model's text response into validated data.
 *
 * Models return JSON wrapped in prose or fenced code blocks often enough that stripping
 * a fence is required, not defensive. Anything beyond that — a truncated object, an
 * invented field — is a real failure and is surfaced as one rather than being coerced.
 */
export function parseModelJson<T>(text: string, schema: ZodType<T>, schemaName: string): T {
  const candidate = stripCodeFence(text).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new ExternalServiceError('ai', `Model did not return valid JSON for ${schemaName}`, {
      retryable: true,
    });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ExternalServiceError(
      'ai',
      `Model output did not match schema ${schemaName}: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'} ${issue.message}`)
        .join('; ')}`,
      { retryable: true },
    );
  }

  return result.data;
}

function stripCodeFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}
