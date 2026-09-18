import { z } from 'zod';

/**
 * JSON column contract for `PostMetric.raw`.
 *
 * The typed columns on `PostMetric` are the numbers we compare across platforms.
 * `raw` keeps the platform's own response so a metric can be re-derived when we learn that
 * we mapped one of those columns wrong — which, given how differently each platform
 * defines "reach", is a matter of when.
 */
export const PostMetricRawSchema = z
  .object({
    /** Which API and version produced this, e.g. "graph-v21.0/insights". */
    endpoint: z.string().min(1).optional(),
    fetchedAt: z.string().datetime().optional(),
    /** Hours since publish, so snapshots can be compared like-for-like. */
    hoursSincePublish: z.number().nonnegative().optional(),
    /** True when the platform was still restating recent numbers. */
    provisional: z.boolean().optional(),
  })
  .passthrough();

export type PostMetricRaw = z.infer<typeof PostMetricRawSchema>;
