import { z } from 'zod';

/**
 * Queue names and payload contracts.
 *
 * **Payloads carry identifiers only.** No tokens, no app secrets, no decrypted anything —
 * docs/10 is explicit, and the reason is that pg-boss payloads are ordinary rows in an
 * ordinary table: readable by anyone with database access, retained after completion, and
 * dumped into whatever backup or log aggregator the platform has. A token in a payload is
 * a token in every one of those places, unencrypted, indefinitely.
 *
 * Each payload is parsed on the way *in* to the handler rather than trusted. A queue row
 * can outlive the code that wrote it — a deploy mid-flight is the ordinary case — so a
 * handler receiving last week's shape is a real event, and a Zod failure naming the field
 * beats a `TypeError` three frames deep.
 */

export const QUEUE = {
  publishTarget: 'publish.target',
  publishSweep: 'publish.sweep',
  credentialValidate: 'credential.validate',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const PublishTargetPayloadSchema = z
  .object({
    targetId: z.string().uuid(),
  })
  .strict();

export type PublishTargetPayload = z.infer<typeof PublishTargetPayloadSchema>;

export const SweepPayloadSchema = z.object({}).strict().default({});

export const CredentialValidatePayloadSchema = z
  .object({
    credentialId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    brandId: z.string().uuid().nullable().default(null),
    platform: z.string().min(1),
  })
  .strict();

export type CredentialValidatePayload = z.infer<typeof CredentialValidatePayloadSchema>;
