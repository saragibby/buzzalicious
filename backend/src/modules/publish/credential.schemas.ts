import { z } from 'zod';

/**
 * JSON column contracts for `SocialAccount.platformMeta` and
 * `PlatformCredential.capabilities`.
 *
 * Nothing here is a secret and nothing here may become one. `platformMeta` is adapter
 * bookkeeping — page ids, account ids — and is returned by the API; tokens live in the
 * encrypted columns and never in JSON, where the Prisma encryption extension cannot see
 * them. See docs/10.
 */

/**
 * Adapter-specific identifiers. Loose on purpose — a platform adding a required id should
 * not need a migration — but the ids we already know we need are named, so a typo in one
 * of them is caught rather than silently stored.
 */
export const PlatformMetaSchema = z
  .object({
    /** Instagram publishing requires a Business/Creator account linked to a FB Page. */
    facebookPageId: z.string().optional(),
    instagramBusinessAccountId: z.string().optional(),
    /** Threads needs its own token and its own user id, not the Instagram one. */
    threadsUserId: z.string().optional(),
    xUserId: z.string().optional(),
    /** Set once pre-flight confirms the account can actually publish (docs/10). */
    isBusinessAccount: z.boolean().optional(),
    timezone: z.string().optional(),
  })
  .passthrough();

export type PlatformMeta = z.infer<typeof PlatformMetaSchema>;

/**
 * The capabilities pre-flight checks. A client's app may be approved for a narrower
 * permission set than we need, and discovering that during a scheduled publish three
 * weeks later is the worst possible outcome (docs/10).
 */
export const CAPABILITIES = [
  'publish_image',
  'publish_carousel',
  'publish_text',
  'publish_video',
  'read_insights',
  'read_hashtags',
] as const;

export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

/**
 * `reason` and `missingScopes` are required-in-spirit when unsupported: the point of the
 * pre-flight report is to tell the client *which permission to request*, not that
 * something is broken.
 */
export const CapabilityReportSchema = z
  .object({
    supported: z.boolean(),
    reason: z.string().optional(),
    missingScopes: z.array(z.string().min(1)).default([]),
    checkedAt: z.string().datetime().optional(),
  })
  .strict();

export const CredentialCapabilitiesSchema = z.record(CapabilitySchema, CapabilityReportSchema);

export type CredentialCapabilities = z.infer<typeof CredentialCapabilitiesSchema>;
