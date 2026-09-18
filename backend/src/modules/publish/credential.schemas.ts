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

/**
 * API input for entering or rotating a credential.
 *
 * Every secret field here is **write-only**: it can be sent, and it is never sent back.
 * `CredentialView` below is the only shape that leaves the server, and it carries a mask
 * rather than a value. docs/10 is explicit that a secret is not returned "not even to the
 * workspace owner who entered it" — the owner already has it, and an API that will hand it
 * over turns a read-only session hijack into a credential theft.
 */
export const CredentialSecretFields = [
  'appSecret',
  'directToken',
  'directTokenSecret',
  'systemUserToken',
] as const;

/**
 * The platform enum on its own.
 *
 * Exported separately because `CredentialInputSchema` is a `ZodEffects` once its
 * cross-field refinements are attached, and a `ZodEffects` has no `.shape` — so a route
 * that needs to validate just a `:platform` path parameter cannot reach into it.
 */
export const PlatformSchema = z.enum([
  'INSTAGRAM',
  'FACEBOOK',
  'THREADS',
  'X',
  'LINKEDIN',
  'TIKTOK',
  'YOUTUBE',
]);

export const CredentialInputSchema = z
  .object({
    platform: PlatformSchema,
    mode: z.enum(['DIRECT_TOKEN', 'CLIENT_APP', 'PLATFORM_APP']),
    label: z.string().min(1).max(120),
    /** Null means the credential is shared across every brand in the workspace. */
    brandId: z.string().uuid().nullable().default(null),
    appId: z.string().min(1).max(200).optional(),
    appSecret: z.string().min(1).max(500).optional(),
    redirectUri: z.string().url().optional(),
    directToken: z.string().min(1).max(4000).optional(),
    directTokenSecret: z.string().min(1).max(4000).optional(),
    systemUserToken: z.string().min(1).max(4000).optional(),
    tokenExpiresAt: z.coerce.date().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === 'CLIENT_APP' && (!value.appId || !value.appSecret)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['appSecret'],
        message: 'CLIENT_APP mode requires both an app ID and an app secret',
      });
    }
    if (value.mode === 'DIRECT_TOKEN' && !value.directToken && !value.systemUserToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['directToken'],
        message: 'DIRECT_TOKEN mode requires a token',
      });
    }
    // docs/10: a Meta DIRECT_TOKEN is a ~60-day bootstrap that cannot be refreshed without
    // the app secret. Without a recorded expiry there is nothing to warn against, and
    // publishing dies silently two months later.
    if (
      value.mode === 'DIRECT_TOKEN' &&
      !value.tokenExpiresAt &&
      ['INSTAGRAM', 'FACEBOOK', 'THREADS'].includes(value.platform)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tokenExpiresAt'],
        message:
          'A Meta DIRECT_TOKEN expires in about 60 days and cannot be refreshed without the app secret. Record its expiry so the platform can warn before it dies.',
      });
    }
  });

export type CredentialInput = z.infer<typeof CredentialInputSchema>;

export const CredentialUpdateSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    appId: z.string().min(1).max(200).optional(),
    appSecret: z.string().min(1).max(500).optional(),
    redirectUri: z.string().url().optional(),
    directToken: z.string().min(1).max(4000).optional(),
    directTokenSecret: z.string().min(1).max(4000).optional(),
    systemUserToken: z.string().min(1).max(4000).optional(),
    tokenExpiresAt: z.coerce.date().nullable().optional(),
  })
  .strict();

export type CredentialUpdate = z.infer<typeof CredentialUpdateSchema>;
