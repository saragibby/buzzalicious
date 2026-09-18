import type { Platform, Prisma, Trend, TrendKind, TrendSignal, TrendStatus } from '@prisma/client';
import type { Db } from '../../platform/db';

/**
 * Data access for the global trend tables.
 *
 * **Typed against `Db`, never `PrismaClient`.** The client in `platform/db.ts` is
 * `$extends`-wrapped to encrypt secrets at rest, which changes its type. A parameter
 * annotated `PrismaClient` still compiles and still passes tests while bypassing that
 * extension — a failure that is invisible until production data is already wrong.
 *
 * **Signals are append-only.** There is deliberately no update or delete path for
 * `TrendSignal` anywhere in this module. docs/07 requires scoring to be re-runnable over
 * full history, which only holds if history is immutable, and the cheapest way to keep an
 * invariant is to never write the function that would break it.
 *
 * **No tenant column.** `Trend`, `TrendSignal` and `TrendCategoryScore` are platform-global
 * per ADR-0010 — one observation is an observation for every workspace. Per-brand scoping
 * happens in `feed.service.ts` as a *view* over this data, computed from the brand's
 * category. Nothing here takes a `workspaceId`, and nothing here should.
 */

export interface TrendWithRelations extends Trend {
  signals: TrendSignal[];
  categoryScores: { categoryId: string; score: number; computedAt: Date }[];
}

const WITH_RELATIONS = {
  // Oldest first: the scorer sorts defensively, but handing it the right order keeps the
  // query and the algorithm agreeing about what "previous observation" means.
  signals: { orderBy: { observedAt: 'asc' } },
  categoryScores: { select: { categoryId: true, score: true, computedAt: true } },
} satisfies Prisma.TrendInclude;

export interface ListTrendsFilter {
  status?: TrendStatus[];
  kind?: TrendKind;
  platform?: Platform | null;
  /** Substring match on title, for the curation admin's search box. */
  search?: string;
  take?: number;
  skip?: number;
}

export async function listTrends(
  db: Db,
  filter: ListTrendsFilter = {},
): Promise<TrendWithRelations[]> {
  const where: Prisma.TrendWhereInput = {};

  if (filter.status?.length) where.status = { in: filter.status };
  if (filter.kind) where.kind = filter.kind;
  // `platform: null` is a meaningful filter (cross-platform trends), so it is only applied
  // when the key is present rather than when the value is truthy.
  if (filter.platform !== undefined) where.platform = filter.platform;
  if (filter.search) where.title = { contains: filter.search, mode: 'insensitive' };

  return db.trend.findMany({
    where,
    include: WITH_RELATIONS,
    orderBy: [{ momentum: 'desc' }, { lastSeenAt: 'desc' }],
    take: filter.take ?? 100,
    skip: filter.skip ?? 0,
  });
}

export async function getTrend(db: Db, id: string): Promise<TrendWithRelations | null> {
  return db.trend.findUnique({ where: { id }, include: WITH_RELATIONS });
}

/** Every trend with its history, for a full scoring re-run. */
export async function listTrendsForScoring(db: Db): Promise<TrendWithRelations[]> {
  return db.trend.findMany({ include: WITH_RELATIONS });
}

export interface TrendIdentity {
  platform: Platform | null;
  kind: TrendKind;
  externalRef: string | null;
}

export interface TrendUpsertInput extends TrendIdentity {
  title: string;
  description?: string | null;
  exampleUrls?: string[];
  raw?: Record<string, unknown>;
}

/**
 * Finds an existing trend by identity, or creates it.
 *
 * v0 resolves on exact `(platform, kind, externalRef)` only — the unique constraint W2
 * declared. docs/07 is explicit that fuzzy matching comes later and behind human review:
 * getting resolution wrong fragments one trend into near-duplicates and destroys the
 * velocity signal, which is the one number the whole engine is built on. A duplicate is
 * recoverable; a silently split history is not.
 *
 * Postgres does not treat `NULL` as equal to `NULL`, so a row with a null `platform` or
 * `externalRef` is not reachable through the composite unique index at all. Those fall
 * back to an explicit `findFirst` on the same three columns plus the title — same
 * intended semantics, expressed in a way the index cannot give us.
 */
export async function resolveOrCreateTrend(db: Db, input: TrendUpsertInput): Promise<Trend> {
  const existing =
    input.platform !== null && input.externalRef !== null
      ? await db.trend.findUnique({
          where: {
            platform_kind_externalRef: {
              platform: input.platform,
              kind: input.kind,
              externalRef: input.externalRef,
            },
          },
        })
      : await db.trend.findFirst({
          where: {
            platform: input.platform,
            kind: input.kind,
            externalRef: input.externalRef,
            ...(input.externalRef === null ? { title: input.title } : {}),
          },
        });

  if (existing) return existing;

  return db.trend.create({
    data: {
      platform: input.platform,
      kind: input.kind,
      externalRef: input.externalRef,
      title: input.title,
      description: input.description ?? null,
      exampleUrls: input.exampleUrls ?? [],
      raw: (input.raw ?? {}) as Prisma.InputJsonObject,
    },
  });
}

export interface TrendPatch {
  title?: string;
  description?: string | null;
  exampleUrls?: string[];
  raw?: Record<string, unknown>;
}

export async function updateTrend(db: Db, id: string, patch: TrendPatch): Promise<Trend> {
  const { raw, ...rest } = patch;
  return db.trend.update({
    where: { id },
    data: { ...rest, ...(raw === undefined ? {} : { raw: raw as Prisma.InputJsonObject }) },
  });
}

/**
 * Read-modify-write on `raw`, against the row as it is *now*.
 *
 * `raw` is one JSON column shared by the collector, the category mapping and the curated
 * angles, so a caller holding a `Trend` it loaded earlier and writing `raw` back will
 * silently erase anything written in between. Found the hard way: saving angles from a
 * stale read wiped the mapping that had been written moments before, and the only
 * symptom was the trend quietly vanishing from every feed.
 *
 * Re-reading inside a transaction narrows that to the width of one statement. This is a
 * consequence of namespacing under `raw` rather than using real columns, and it goes away
 * when W2 adds `Trend.curation` — noted in the PR.
 */
export async function mergeRaw(
  db: Db,
  id: string,
  merge: (raw: unknown) => Record<string, unknown>,
): Promise<Trend> {
  return db.$transaction(async (tx) => {
    const current = await tx.trend.findUniqueOrThrow({ where: { id }, select: { raw: true } });
    return tx.trend.update({
      where: { id },
      data: { raw: merge(current.raw) as Prisma.InputJsonObject },
    });
  });
}

export interface SignalInput {
  trendId: string;
  collectorId: string;
  observedAt: Date;
  metrics: Prisma.InputJsonValue;
}

/**
 * Appends one observation and advances `lastSeenAt`.
 *
 * Both writes go in a transaction because a signal whose trend still claims an older
 * `lastSeenAt` would be scored as stale while carrying fresh data — the trend would drop
 * out of the feed for a reason nobody could see in the data.
 */
export async function appendSignal(db: Db, input: SignalInput): Promise<TrendSignal> {
  const [signal] = await db.$transaction([
    db.trendSignal.create({
      data: {
        trendId: input.trendId,
        collectorId: input.collectorId,
        observedAt: input.observedAt,
        metrics: input.metrics,
      },
    }),
    db.trend.update({
      where: { id: input.trendId },
      data: { lastSeenAt: input.observedAt },
    }),
  ]);

  return signal;
}

export interface ScorePatch {
  velocity: number;
  momentum: number;
  status: TrendStatus;
  peakedAt: Date | null;
}

/**
 * Writes a recomputed score back.
 *
 * Deliberately does not touch `lastSeenAt`: that is an observation fact owned by the
 * collectors, and letting a scoring run move it would mean re-running scoring made every
 * trend look freshly observed, quietly defeating `ageDecay`.
 */
export async function writeScore(db: Db, trendId: string, patch: ScorePatch): Promise<void> {
  await db.trend.update({ where: { id: trendId }, data: patch });
}

export interface CategoryScoreInput {
  categoryId: string;
  score: number;
}

/**
 * Replaces a trend's category scores wholesale.
 *
 * Replace rather than merge: a re-mapping that no longer considers a category relevant
 * must be able to *remove* it. Merging would leave a stale high score behind forever, and
 * a trend that was once mapped to the wrong category would keep surfacing there — exactly
 * the "confidently wrong mapping" the brief warns erodes trust faster than a thin feed.
 */
export async function replaceCategoryScores(
  db: Db,
  trendId: string,
  scores: CategoryScoreInput[],
  computedAt: Date,
): Promise<void> {
  await db.$transaction([
    db.trendCategoryScore.deleteMany({ where: { trendId } }),
    db.trendCategoryScore.createMany({
      data: scores.map((s) => ({
        trendId,
        categoryId: s.categoryId,
        score: s.score,
        computedAt,
      })),
      skipDuplicates: true,
    }),
  ]);
}

/** Trend ids a brand has already posted against, so the feed does not repeat itself. */
export async function usedTrendIds(db: Db, brandId: string): Promise<Set<string>> {
  const posts = await db.post.findMany({
    where: { brandId, trendId: { not: null } },
    select: { trendId: true },
    distinct: ['trendId'],
  });

  return new Set(posts.map((p) => p.trendId).filter((id): id is string => id !== null));
}
