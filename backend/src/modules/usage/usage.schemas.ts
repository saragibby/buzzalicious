import { z } from 'zod';

/**
 * Shape of `UsageEvent.metadata`.
 *
 * Deliberately loose and deliberately small. The metadata column is for the detail that
 * makes a line item explicable to a human reading an invoice dispute — which model, which
 * platform, which size — not a second place to keep facts that belong in columns. Anything
 * aggregated or filtered on gets a column; anything queried by a job gets a relation.
 *
 * Validated on write so the column stays readable, but not exhaustively typed, because
 * pinning every metric's payload here would make adding a metric a schema negotiation.
 */
export const UsageMetadataSchema = z
  .object({
    purpose: z.string().max(100).optional(),
    provider: z.string().max(50).optional(),
    model: z.string().max(100).optional(),
    platform: z.string().max(50).optional(),
    promptTokens: z.number().int().nullable().optional(),
    completionTokens: z.number().int().nullable().optional(),
    note: z.string().max(500).optional(),
  })
  .passthrough();

export type UsageMetadata = z.infer<typeof UsageMetadataSchema>;

/** `YYYY-MM`, the only period format the API accepts. */
export const PeriodKeySchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Period must be YYYY-MM');
