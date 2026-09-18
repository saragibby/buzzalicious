import type { PlatformCredential, Platform, Prisma } from '@prisma/client';
import type { ScopedDb } from '../../platform/tenancy';
import { NotFoundError } from '../../platform/errors';
import {
  CredentialSecretFields,
  type CredentialCapabilities,
  type CredentialInput,
  type CredentialUpdate,
} from './credential.schemas';

/**
 * Credential CRUD, and the only place a credential becomes something an API may return.
 *
 * docs/10's handling rules are enforced here rather than remembered at each route:
 * secrets are write-only, reads are masked, and the mask is produced by a function that
 * cannot accidentally be given the whole value — `toCredentialView` never spreads the
 * row, it names every field it emits. A spread plus a delete is one rename away from
 * leaking, and this has to survive people adding columns.
 */

/** What the API returns. No field here is or can become a secret. */
export interface CredentialView {
  id: string;
  workspaceId: string;
  brandId: string | null;
  platform: Platform;
  mode: PlatformCredential['mode'];
  label: string;
  appId: string | null;
  redirectUri: string | null;
  /** `••••••••1234`, or null when nothing is stored. Identification only. */
  appSecretMask: string | null;
  directTokenMask: string | null;
  systemUserTokenMask: string | null;
  tokenExpiresAt: Date | null;
  /** Days until `tokenExpiresAt`, negative once past. Drives the upgrade prompt. */
  expiresInDays: number | null;
  grantedScopes: string[];
  requiredScopes: string[];
  capabilities: CredentialCapabilities | null;
  status: PlatformCredential['status'];
  lastValidatedAt: Date | null;
  lastError: string | null;
  rotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const MASK = '••••••••';

/**
 * Mask a secret for display.
 *
 * The last four characters are kept because a client holding three Meta apps needs some
 * way to tell which row is which, and "the one ending 8f21" is how they actually think
 * about it. Four characters of a 32-character secret is not a meaningful disclosure; the
 * short-value branch exists so a mistakenly-short value cannot be shown nearly whole.
 */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return MASK;
  return `${MASK}${value.slice(-4)}`;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function toCredentialView(
  credential: PlatformCredential,
  now: Date = new Date(),
): CredentialView {
  return {
    id: credential.id,
    workspaceId: credential.workspaceId,
    brandId: credential.brandId,
    platform: credential.platform,
    mode: credential.mode,
    label: credential.label,
    appId: credential.appId,
    redirectUri: credential.redirectUri,
    appSecretMask: maskSecret(credential.appSecret),
    directTokenMask: maskSecret(credential.directToken),
    systemUserTokenMask: maskSecret(credential.systemUserToken),
    tokenExpiresAt: credential.tokenExpiresAt,
    expiresInDays:
      credential.tokenExpiresAt === null
        ? null
        : Math.floor((credential.tokenExpiresAt.getTime() - now.getTime()) / MS_PER_DAY),
    grantedScopes: credential.grantedScopes,
    requiredScopes: credential.requiredScopes,
    capabilities: (credential.capabilities as CredentialCapabilities | null) ?? null,
    status: credential.status,
    lastValidatedAt: credential.lastValidatedAt,
    lastError: credential.lastError,
    rotatedAt: credential.rotatedAt,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}

/**
 * Assert an object carries no plaintext secret. Used by the route tests, and cheap enough
 * to leave in the read path if that ever seems worth it.
 */
export function containsSecretField(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ((CredentialSecretFields as readonly string[]).includes(key)) return key;
    const found = containsSecretField(nested);
    if (found) return found;
  }
  return null;
}

export async function listCredentials(
  db: ScopedDb,
  options: { platform?: Platform; brandId?: string | null } = {},
): Promise<CredentialView[]> {
  const rows = await db.platformCredential.findMany({
    where: {
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.brandId === undefined ? {} : { brandId: options.brandId }),
    },
    orderBy: [{ platform: 'asc' }, { createdAt: 'asc' }],
  });
  const now = new Date();
  return rows.map((row) => toCredentialView(row, now));
}

export async function getCredential(db: ScopedDb, id: string): Promise<PlatformCredential> {
  const row = await db.platformCredential.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Credential');
  return row;
}

export async function createCredential(
  db: ScopedDb,
  input: CredentialInput,
): Promise<CredentialView> {
  // `workspaceId` is stamped by the tenancy extension (`TENANT_MODELS.PlatformCredential`
  // carries `createField: workspaceId`). Naming it here would be a second source of truth
  // for the value scoping exists to control, and a wrong one would type-check.
  //
  // Prisma's generated input still requires the column, so the payload is built against the
  // input type minus that one field and widened at the call. The narrow cast matters: an
  // `as` on the object literal would also switch off excess-property checking, which is the
  // check that stops a typo'd secret field from being silently dropped.
  const data: Omit<Prisma.PlatformCredentialUncheckedCreateInput, 'workspaceId'> = {
    platform: input.platform,
    mode: input.mode,
    label: input.label,
    brandId: input.brandId,
    appId: input.appId ?? null,
    appSecret: input.appSecret ?? null,
    redirectUri: input.redirectUri ?? null,
    directToken: input.directToken ?? null,
    directTokenSecret: input.directTokenSecret ?? null,
    systemUserToken: input.systemUserToken ?? null,
    tokenExpiresAt: input.tokenExpiresAt ?? null,
    grantedScopes: [],
    requiredScopes: [],
    status: 'PENDING',
  };

  const created = await db.platformCredential.create({
    data: data as Prisma.PlatformCredentialUncheckedCreateInput,
  });

  return toCredentialView(created);
}

/**
 * Update a credential, optionally rotating its secrets.
 *
 * Rotation is not a separate table or a separate call: docs/10's rotation runbook is
 * "update the credential, re-run pre-flight, mark dependent accounts". Supplying a new
 * `appSecret` stamps `rotatedAt` and drops the credential back to `PENDING`, because a
 * credential whose secret just changed has not been validated and claiming otherwise is
 * how a rotation silently breaks publishing.
 */
export async function updateCredential(
  db: ScopedDb,
  id: string,
  update: CredentialUpdate,
): Promise<CredentialView> {
  await getCredential(db, id);

  const rotatesSecret =
    update.appSecret !== undefined ||
    update.directToken !== undefined ||
    update.systemUserToken !== undefined;

  const updated = await db.platformCredential.update({
    where: { id },
    data: {
      ...(update.label === undefined ? {} : { label: update.label }),
      ...(update.appId === undefined ? {} : { appId: update.appId }),
      ...(update.appSecret === undefined ? {} : { appSecret: update.appSecret }),
      ...(update.redirectUri === undefined ? {} : { redirectUri: update.redirectUri }),
      ...(update.directToken === undefined ? {} : { directToken: update.directToken }),
      ...(update.directTokenSecret === undefined
        ? {}
        : { directTokenSecret: update.directTokenSecret }),
      ...(update.systemUserToken === undefined ? {} : { systemUserToken: update.systemUserToken }),
      ...(update.tokenExpiresAt === undefined ? {} : { tokenExpiresAt: update.tokenExpiresAt }),
      ...(rotatesSecret ? { rotatedAt: new Date(), status: 'PENDING' as const } : {}),
    },
  });

  return toCredentialView(updated);
}
