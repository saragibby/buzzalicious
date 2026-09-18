import { Platform, TrendKind, TrendStatus } from '@prisma/client';
import type { Db } from '../../src/platform/db';
import { categoryId } from './taxonomy';
import { createRng, jitter, seedId } from './deterministic';

/**
 * Global trends with their signal history and category relevance (docs/07).
 *
 * Trends carry no `workspaceId` — one trend observed once is a trend for every workspace
 * (ADR-0010). What differs per tenant is *relevance*, which is what `TrendCategoryScore`
 * expresses: a tax practice and a vacation rental should never see the same top trend.
 *
 * Each trend gets several `TrendSignal` snapshots rather than one current number, because
 * the ranking in docs/07 is about velocity and momentum — a trend at 10,000 mentions and
 * falling is worth less than one at 4,000 and doubling, and a single mutable counter
 * cannot tell those apart.
 */

interface TrendSpec {
  key: string;
  title: string;
  description: string;
  platform: Platform | null;
  kind: TrendKind;
  externalRef: string | null;
  status: TrendStatus;
  velocity: number;
  momentum: number;
  /** Observation window, oldest first, as `[daysAgo, mentions]`. */
  observations: [number, number][];
  categories: { slug: string; score: number }[];
  exampleUrls: string[];
}

export const TRENDS: TrendSpec[] = [
  {
    key: 'quiet-luxury-coastal',
    title: 'Quiet coastal styling',
    description:
      'Muted, un-staged interiors shot in natural light. Reads as restful rather than styled.',
    platform: Platform.INSTAGRAM,
    kind: TrendKind.FORMAT,
    externalRef: 'ig-format-quiet-coastal',
    status: TrendStatus.PEAKING,
    velocity: 0.42,
    momentum: 0.78,
    observations: [
      [45, 8200],
      [30, 14800],
      [16, 26400],
      [7, 31900],
      [2, 33100],
    ],
    categories: [
      { slug: 'vacation-rental', score: 0.93 },
      { slug: 'hospitality-and-travel', score: 0.86 },
      { slug: 'boutique-hotel', score: 0.8 },
      { slug: 'home-goods', score: 0.55 },
    ],
    exampleUrls: ['https://example.com/seed/trends/quiet-coastal-1'],
  },
  {
    key: 'shoulder-season-value',
    title: 'Shoulder-season value posts',
    description:
      'Off-peak pricing framed as "same place, half the people" rather than as a discount.',
    platform: null,
    kind: TrendKind.TOPIC,
    externalRef: 'topic-shoulder-season',
    status: TrendStatus.EMERGING,
    velocity: 0.61,
    momentum: 0.58,
    observations: [
      [21, 1900],
      [12, 3400],
      [5, 6100],
      [1, 7800],
    ],
    categories: [
      { slug: 'vacation-rental', score: 0.88 },
      { slug: 'campground-rv-park', score: 0.72 },
      { slug: 'tour-operator', score: 0.66 },
    ],
    exampleUrls: [],
  },
  {
    key: 'quarterly-estimates-panic',
    title: 'Quarterly estimate reminders',
    description:
      'Deadline-anchored reminders for self-employed filers. Spikes hard on a known calendar.',
    platform: Platform.X,
    kind: TrendKind.TOPIC,
    externalRef: 'x-topic-quarterly-estimates',
    status: TrendStatus.PEAKING,
    velocity: 0.88,
    momentum: 0.91,
    observations: [
      [14, 4200],
      [9, 11500],
      [4, 24700],
      [1, 38900],
    ],
    categories: [
      { slug: 'tax-prep', score: 0.97 },
      { slug: 'bookkeeping', score: 0.84 },
      { slug: 'professional-services', score: 0.71 },
      { slug: 'financial-advisor', score: 0.62 },
    ],
    exampleUrls: ['https://example.com/seed/trends/quarterly-estimates-1'],
  },
  {
    key: 'deduction-myths',
    title: 'Deduction myth-busting',
    description: 'Short corrections of widely repeated bad tax advice. Reliably high on saves.',
    platform: null,
    kind: TrendKind.FORMAT,
    externalRef: 'format-deduction-myths',
    status: TrendStatus.EMERGING,
    velocity: 0.55,
    momentum: 0.63,
    observations: [
      [28, 2100],
      [18, 3900],
      [8, 7200],
      [2, 9600],
    ],
    categories: [
      { slug: 'tax-prep', score: 0.94 },
      { slug: 'bookkeeping', score: 0.7 },
      { slug: 'law-practice', score: 0.44 },
    ],
    exampleUrls: [],
  },
  {
    key: 'golden-hour-tour',
    title: 'Golden-hour walkthroughs',
    description: 'A single unbroken walk through a space, shot in the last hour of light.',
    platform: Platform.INSTAGRAM,
    kind: TrendKind.FORMAT,
    externalRef: 'ig-format-golden-hour-tour',
    status: TrendStatus.DECLINING,
    velocity: -0.22,
    momentum: 0.19,
    observations: [
      [60, 41000],
      [40, 36500],
      [20, 24100],
      [6, 15300],
    ],
    categories: [
      { slug: 'vacation-rental', score: 0.74 },
      { slug: 'real-estate-agent', score: 0.81 },
      { slug: 'event-venue', score: 0.58 },
    ],
    exampleUrls: [],
  },
  {
    key: 'receipts-shoebox',
    title: 'The shoebox confession',
    description:
      'Clients admitting how they store receipts. Self-deprecating, high on replies, low on saves.',
    platform: Platform.THREADS,
    kind: TrendKind.TOPIC,
    externalRef: 'threads-topic-shoebox',
    status: TrendStatus.STALE,
    velocity: -0.05,
    momentum: 0.04,
    observations: [
      [120, 6400],
      [90, 5100],
      [60, 2200],
      [30, 900],
    ],
    categories: [
      { slug: 'tax-prep', score: 0.55 },
      { slug: 'bookkeeping', score: 0.61 },
    ],
    exampleUrls: [],
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;

export function trendId(key: string): string {
  return seedId('trend', key);
}

export async function seedTrends(db: Db, now: Date): Promise<number> {
  for (const spec of TRENDS) {
    const id = trendId(spec.key);
    const rng = createRng(`trend:${spec.key}`);

    const firstSeenAt = new Date(now.getTime() - spec.observations[0]![0] * DAY_MS);
    const lastSeenAt = new Date(
      now.getTime() - spec.observations[spec.observations.length - 1]![0] * DAY_MS,
    );
    const peak = [...spec.observations].sort((a, b) => b[1] - a[1])[0]!;

    const data = {
      platform: spec.platform,
      kind: spec.kind,
      externalRef: spec.externalRef,
      title: spec.title,
      description: spec.description,
      exampleUrls: spec.exampleUrls,
      firstSeenAt,
      lastSeenAt,
      // Only a trend that has actually turned over has a peak; an emerging one has not.
      peakedAt:
        spec.status === TrendStatus.PEAKING ||
        spec.status === TrendStatus.DECLINING ||
        spec.status === TrendStatus.STALE
          ? new Date(now.getTime() - peak[0] * DAY_MS)
          : null,
      status: spec.status,
      velocity: spec.velocity,
      momentum: spec.momentum,
      raw: {
        collector: 'seed',
        collectedAt: now.toISOString(),
        note: 'Synthetic seed data. Not observed from any platform API.',
      },
    };

    await db.trend.upsert({ where: { id }, create: { id, ...data }, update: data });

    for (const [daysAgo, mentions] of spec.observations) {
      const signalId = seedId('trend-signal', spec.key, String(daysAgo));
      const observedAt = new Date(now.getTime() - daysAgo * DAY_MS);
      const signal = {
        trendId: id,
        collectorId: 'seed',
        observedAt,
        metrics: {
          mentions,
          uniqueAuthors: jitter(rng, Math.round(mentions * 0.62), 0.15),
          engagements: jitter(rng, mentions * 4, 0.25),
          sampleSize: spec.observations.length,
        },
      };
      await db.trendSignal.upsert({
        where: { id: signalId },
        create: { id: signalId, ...signal },
        update: signal,
      });
    }

    for (const category of spec.categories) {
      await db.trendCategoryScore.upsert({
        where: {
          trendId_categoryId: { trendId: id, categoryId: categoryId(category.slug) },
        },
        create: {
          trendId: id,
          categoryId: categoryId(category.slug),
          score: category.score,
          computedAt: now,
        },
        update: { score: category.score, computedAt: now },
      });
    }
  }

  return TRENDS.length;
}
