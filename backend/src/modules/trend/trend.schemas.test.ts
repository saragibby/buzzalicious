import { describe, expect, it } from 'vitest';
import { TrendRawSchema, TrendSignalMetricsSchema } from './trend.schemas';

describe('TrendSignalMetricsSchema', () => {
  it('accepts a partial observation', () => {
    // No two sources expose the same measurements. A collector forced to invent a zero
    // has corrupted the signal before it is stored.
    const parsed = TrendSignalMetricsSchema.parse({ postCount: 412 });
    expect(parsed).toEqual({ postCount: 412 });
  });

  it('rejects a negative volume', () => {
    expect(TrendSignalMetricsSchema.safeParse({ volume: -1 }).success).toBe(false);
  });

  it('rejects a confidence outside 0..1', () => {
    expect(TrendSignalMetricsSchema.safeParse({ confidence: 2 }).success).toBe(false);
  });

  it('allows a negative delta, which is how decline is observed', () => {
    expect(TrendSignalMetricsSchema.safeParse({ deltaVolume: -300 }).success).toBe(true);
  });
});

describe('TrendRawSchema', () => {
  it('preserves the source payload verbatim', () => {
    // Scoring is re-run over history when the algorithm changes (docs/07), which only
    // works if the raw observation survived intact.
    const parsed = TrendRawSchema.parse({
      collectorId: 'meta-hashtag',
      nested: { anything: [1, 2, 3] },
    });
    expect(parsed).toMatchObject({ nested: { anything: [1, 2, 3] } });
  });

  it('rejects a malformed source URL', () => {
    expect(TrendRawSchema.safeParse({ sourceUrl: 'not a url' }).success).toBe(false);
  });
});
