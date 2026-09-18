import { describe, expect, it } from 'vitest';
import { PostMetricRawSchema } from './metric.schemas';

describe('PostMetricRawSchema', () => {
  it('keeps the platform response alongside the named fields', () => {
    // Each platform defines "reach" differently, so a column mapping will turn out to be
    // wrong. Keeping the raw body is what makes that recoverable rather than a data loss.
    const parsed = PostMetricRawSchema.parse({
      endpoint: 'graph-v21.0/insights',
      hoursSincePublish: 24,
      data: [{ name: 'reach', values: [{ value: 1200 }] }],
    });
    expect(parsed).toMatchObject({ data: [{ name: 'reach', values: [{ value: 1200 }] }] });
  });

  it('rejects a negative hours-since-publish', () => {
    expect(PostMetricRawSchema.safeParse({ hoursSincePublish: -3 }).success).toBe(false);
  });

  it('rejects a non-ISO fetch timestamp', () => {
    expect(PostMetricRawSchema.safeParse({ fetchedAt: 'yesterday' }).success).toBe(false);
  });
});
