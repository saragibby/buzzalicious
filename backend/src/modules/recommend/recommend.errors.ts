import { AppError } from '../../platform/errors';

/**
 * 500 — a recommendation invariant that should be impossible to violate was violated.
 *
 * This is deliberately not a `ValidationError`. Nothing the caller sent can cause it; it
 * means an assumption inside the scoring code is wrong. `expose` is false because the
 * message names internal state, and because "something is wrong with our maths" is not a
 * thing the client can act on.
 *
 * It exists at all because the alternative in a recommender is worse. A send-time
 * suggestion that silently falls back to a plausible-looking wrong instant is indis-
 * tinguishable from a correct one at the call site, and would be scheduled.
 */
export class RecommendInvariantError extends AppError {
  readonly code = 'INTERNAL_ERROR' as const;
  readonly status = 500;
  override readonly expose = false;
}
