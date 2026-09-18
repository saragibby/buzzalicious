import type { Platform, TrendKind } from '@prisma/client';

/**
 * The contract every trend source implements (docs/01, docs/07).
 *
 * One implementation per source, so adding a source never changes a caller. v0 ships
 * exactly one — manual curation — and that is the point: docs/07 bounds v0 to the manual
 * collector plus *one* automated collector, and one done well beats four done badly.
 *
 * Two rules every implementation inherits:
 *
 * 1. **Degrade, never throw upward.** A source being down is a quiet gap in the feed, not
 *    a failed page. `collect` returns what it got.
 * 2. **Derived signals, not content.** Collectors record measurements and references.
 *    Copying other people's posts into our database is both a ToS problem and not
 *    something the scorer can use.
 *
 * Automated collectors additionally resolve credentials through `resolveCollectorCredential`
 * (`modules/publish/credential.resolver`), which hands back Buzzalicious's own app and
 * **cannot** reach a client's — it takes no database handle, so the constraint in docs/07
 * and ADR-0009 is enforced by the signature rather than left to memory. Never call
 * `resolveCredential` from a collector: it runs the full brand → workspace → platform
 * fallback, and collecting on a client's quota degrades the publishing they pay for.
 */
export interface TrendCollector {
  readonly id: string;
  readonly label: string;
  /** False when the collector needs credentials or config it does not have. */
  isConfigured(): boolean;
  collect(input: CollectorRunInput): Promise<CollectedObservation[]>;
}

export interface CollectorRunInput {
  /** Passed in rather than read from the clock, so a run is reproducible in a test. */
  now: Date;
}

/**
 * One normalized observation, before it is resolved against an existing `Trend`.
 *
 * `metrics` is deliberately loose — `TrendSignalMetricsSchema` is `.passthrough()` because
 * a collector forced to invent a zero to satisfy a schema has corrupted the signal before
 * it is stored.
 */
export interface CollectedObservation {
  platform: Platform | null;
  kind: TrendKind;
  externalRef: string | null;
  title: string;
  description?: string | null;
  exampleUrls?: string[];
  observedAt: Date;
  metrics: Record<string, unknown>;
  /** Provenance written into `Trend.raw`. Never a credential, never post content. */
  raw?: Record<string, unknown>;
}
