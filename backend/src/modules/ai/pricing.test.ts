import { describe, expect, it } from 'vitest';
import { estimateProviderCostUsd, pricedModels, rateFor, totalTokens } from './pricing';

/**
 * Provider cost estimation.
 *
 * The properties worth pinning are the ones whose failure is silent: an unknown model must
 * not be priced, a dated model id must resolve to its base rate, and `gpt-4o-mini` must
 * never be priced as `gpt-4o` — which is a 16× error in the same direction as the bill.
 */
describe('ai pricing', () => {
  it('prices a known model from its published rate', () => {
    // 1,000,000 prompt tokens at $0.15/M and 1,000,000 completion at $0.60/M.
    const cost = estimateProviderCostUsd('gpt-4o-mini', {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    });

    expect(cost?.toString()).toBe('0.75');
  });

  it('keeps sub-cent precision instead of rounding a small call to zero', () => {
    const cost = estimateProviderCostUsd('gpt-4o-mini', {
      promptTokens: 1_000,
      completionTokens: 200,
      totalTokens: 1_200,
    });

    // 1000 × 0.15/M + 200 × 0.60/M = 0.00015 + 0.00012 = 0.00027
    expect(cost?.toString()).toBe('0.00027');
    expect(cost?.isZero()).toBe(false);
  });

  it('resolves a dated model id to its base rate', () => {
    expect(rateFor('gpt-4o-mini-2024-07-18')).toEqual(rateFor('gpt-4o-mini'));
  });

  it('does not price gpt-4o-mini as gpt-4o', () => {
    // Longest-prefix matching. First-match-wins over an unordered object would make this
    // 16× too expensive, and nothing downstream would notice.
    const mini = rateFor('gpt-4o-mini-2024-07-18');
    const full = rateFor('gpt-4o-2024-11-20');

    expect(mini?.inputPerMillion).toBe('0.15');
    expect(full?.inputPerMillion).toBe('2.50');
    expect(mini).not.toEqual(full);
  });

  it('returns null for an unknown model rather than guessing', () => {
    expect(rateFor('claude-opus-9')).toBeNull();
    expect(
      estimateProviderCostUsd('claude-opus-9', {
        promptTokens: 5_000,
        completionTokens: 5_000,
        totalTokens: 10_000,
      }),
    ).toBeNull();
  });

  it('returns null when the provider reported no usage', () => {
    expect(estimateProviderCostUsd('gpt-4o-mini', undefined)).toBeNull();
    expect(
      estimateProviderCostUsd('gpt-4o-mini', {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      }),
    ).toBeNull();
  });

  it('is case- and whitespace-insensitive about model ids', () => {
    expect(rateFor('  GPT-4O-MINI  ')).toEqual(rateFor('gpt-4o-mini'));
  });

  it('falls back to prompt + completion when a provider omits the total', () => {
    expect(totalTokens({ promptTokens: 700, completionTokens: 300 })).toBe(1_000);
    expect(totalTokens({ promptTokens: 700, completionTokens: 300, totalTokens: 999 })).toBe(999);
    expect(totalTokens(undefined)).toBe(0);
  });

  it('covers both providers the app can be configured with', () => {
    const models = pricedModels();
    expect(models.some((m) => m.startsWith('gpt-'))).toBe(true);
    expect(models.some((m) => m.startsWith('gemini-'))).toBe(true);
  });
});
