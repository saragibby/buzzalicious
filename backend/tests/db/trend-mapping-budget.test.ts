import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma, TrendKind } from '@prisma/client';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { seedAll } from '../../prisma/seed/index';
import { hasTestDatabase } from '../env';
import { recordManualObservation } from '../../src/modules/trend/collectors/manual.collector';
import { loadTaxonomy, mapTrend } from '../../src/modules/trend/mapping/mapping.service';
import { getTrend } from '../../src/modules/trend/trend.repository';
import { BudgetExceededError } from '../../src/modules/usage/usage.errors';
import { ExternalServiceError } from '../../src/platform/errors';
import { generateStructuredMetered } from '../../src/modules/ai/metered';

vi.mock('../../src/modules/ai/metered', () => ({
  generateStructuredMetered: vi.fn(),
  generateTextMetered: vi.fn(),
}));

const meteredCall = vi.mocked(generateStructuredMetered);

/**
 * ADR-0011 singles this out as the thing the fuse must not get wrong.
 *
 * Trend classification deliberately swallows model failures — a dead provider must degrade
 * to rule matches, not stall the pipeline. A spend refusal arrives through the same `catch`
 * and looks identical to a provider outage, so the naive version of that handler converts
 * "you are over your ceiling" into "the model returned nothing" and the fuse silently does
 * nothing at all.
 *
 * Both halves are asserted here, because either one alone passes for the wrong reason: a
 * service that rethrows everything satisfies the refusal test while breaking degradation,
 * and a service that swallows everything satisfies the degradation test while breaking the
 * fuse.
 */
describe.skipIf(!hasTestDatabase)('trend mapping under the AI spend fuse', () => {
  const SYNTHETIC_REF = 'w10-budget-rethrow-test';
  const NOW = new Date('2026-03-01T00:00:00Z');
  let db: Db;

  beforeAll(async () => {
    db = getPrisma();
    await seedAll(db);
  }, 120_000);

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await db.trend.deleteMany({ where: { externalRef: SYNTHETIC_REF } });
    await disconnectPrisma();
  });

  /**
   * A trend the rules cannot classify, so the model layer is actually reached.
   *
   * If the rules scored this above `NEEDS_REVIEW_BELOW` the LLM call would be skipped and
   * both tests below would pass without ever exercising the code they are about — the
   * exact failure mode this suite is meant to catch. `expect(meteredCall)` having been
   * called is asserted in both tests to keep that honest.
   */
  async function unclassifiableTrend() {
    const created = await recordManualObservation(db, {
      platform: null,
      kind: TrendKind.TOPIC,
      externalRef: SYNTHETIC_REF,
      title: 'Qwlfj zzt brindle vantablack',
      description: 'Nothing here matches any taxonomy rule.',
      exampleUrls: [],
      curatedBy: 'test@buzzalicious.test',
      observedAt: NOW,
      metrics: { volume: 10 },
    });

    return (await getTrend(db, created.id))!;
  }

  it('propagates a budget refusal instead of degrading to rule matches', async () => {
    const trend = await unclassifiableTrend();
    const taxonomy = await loadTaxonomy(db);

    meteredCall.mockRejectedValue(
      new BudgetExceededError(
        'platform',
        new Prisma.Decimal('25.41'),
        new Prisma.Decimal('25.00'),
        new Date('2026-03-01T00:00:00Z'),
      ),
    );

    await expect(mapTrend(db, trend, taxonomy, NOW, { force: true })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(meteredCall).toHaveBeenCalledOnce();
  });

  it('still degrades to rule matches when the provider itself fails', async () => {
    const trend = await unclassifiableTrend();
    const taxonomy = await loadTaxonomy(db);

    meteredCall.mockRejectedValue(new ExternalServiceError('gemini', 'gemini is down'));

    const result = await mapTrend(db, trend, taxonomy, NOW, { force: true });

    expect(meteredCall).toHaveBeenCalledOnce();
    expect(result.mapping.method).toBe('rules');
  });
});
