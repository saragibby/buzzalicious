import request from 'supertest';
import { createApp } from '../../src/http/app';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectPrisma, getPrisma, type Db } from '../../src/platform/db';
import { seedAll } from '../../prisma/seed/index';
import { hasTestDatabase } from '../env';
import { periodKeyFor } from '../../src/modules/usage/period';

// Only the two auth layers are replaced. The read layer, Prisma's BigInt and Decimal
// values, and Express's own `res.json` are all real — which is the entire point: the risk
// this test exists for lives in serialization, not in authorization, and authorization is
// already pinned by usage-admin.routes.test.ts.
vi.mock('../../src/http/middleware/require-auth', () => ({
  requireAuth: (req: { user?: { id: string; email: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 'test-admin', email: 'admin@buzzalicious.test' };
    next();
  },
}));

vi.mock('../../src/modules/usage/usage.access', () => ({
  isPlatformAdmin: () => true,
  assertPlatformAdmin: () => undefined,
}));

/**
 * That the admin usage response actually serializes.
 *
 * `UsagePeriodRollup.quantity` is a `BigInt`, and `JSON.stringify` throws a `TypeError` on
 * one — not a 500 from a caught error, an unhandled throw inside `res.json` after the
 * handler has already succeeded. `usage.read.ts` converts at the boundary, but nothing
 * forced it to: a field added later that returns a Prisma row straight through would fail
 * only at runtime, only on a populated database, and only for the one admin who looks.
 *
 * So this asserts the real HTTP body over real seeded rows, and re-stringifies what came
 * back. Asserting `status === 200` alone would not be enough — the throw happens during
 * serialization, so the failure mode is a broken response, and the body has to be
 * inspected to see it.
 */
describe.skipIf(!hasTestDatabase)('admin usage response serialization', () => {
  let db: Db;

  beforeAll(async () => {
    db = getPrisma();
    await seedAll(db);
  }, 120_000);

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('returns a JSON body with no BigInt left in it', async () => {
    const period = periodKeyFor(new Date());
    const response = await request(createApp()).get(`/api/admin/usage?period=${period}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/json/);

    // The control. The seed writes usage history for every workspace, so an empty payload
    // would mean this serialized nothing and proved nothing.
    expect(response.body.period).toBe(period);
    expect(Array.isArray(response.body.workspaces)).toBe(true);
    expect(response.body.workspaces.length).toBeGreaterThan(0);

    const quantities = response.body.workspaces.flatMap((w: { metrics?: unknown[] }) =>
      (w.metrics ?? []).map((m) => (m as { quantity: unknown }).quantity),
    );
    expect(quantities.length).toBeGreaterThan(0);
    expect(quantities.every((q: unknown) => typeof q === 'number')).toBe(true);

    // Round-trip what actually came over the wire. If any value were still a BigInt the
    // request above would have failed before reaching here, but this also catches a value
    // that survived transport in a shape nothing downstream can re-encode.
    expect(() => JSON.stringify(response.body)).not.toThrow();
  });
});
