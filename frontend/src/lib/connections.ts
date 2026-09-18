import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from './api';

/**
 * Typed client for the W6 connection surfaces.
 *
 * Two different scopes, because the two things are genuinely scoped differently and
 * flattening them in the UI would hide a real permission boundary: a *credential* is the
 * client's platform app and belongs to the workspace, while a *connected account* is a
 * Page or profile and belongs to a brand. One credential can mint accounts for several
 * brands, which is why revoking is a workspace-level act with a brand-level blast radius.
 */

export type PlatformName = 'X' | 'FACEBOOK' | 'INSTAGRAM' | 'THREADS';

export type AccountStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'ERROR' | 'DISCONNECTED';

export type CredentialStatus = 'ACTIVE' | 'INVALID' | 'EXPIRED' | 'REVOKED' | 'INSUFFICIENT';

export interface Connection {
  id: string;
  platform: PlatformName;
  externalId: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  status: AccountStatus;
  lastError: string | null;
  lastValidatedAt: string | null;
  expiresAt: string | null;
  scopes: string[];
  credentialId: string | null;
  credentialLabel: string | null;
  needsAttention: boolean;
}

export interface CredentialView {
  id: string;
  platform: PlatformName;
  label: string;
  kind: string;
  status: CredentialStatus;
  brandId: string | null;
  lastError: string | null;
  expiresAt: string | null;
}

export const connectionKeys = {
  accounts: (brandId: string) => ['publishing', 'accounts', brandId] as const,
  credentials: (workspaceId: string) => ['publishing', 'credentials', workspaceId] as const,
};

export function useConnections(brandId: string | null): UseQueryResult<Connection[]> {
  return useQuery({
    queryKey: connectionKeys.accounts(brandId ?? 'none'),
    enabled: brandId !== null,
    queryFn: async () => {
      const body = await apiFetch<{ accounts: Connection[] }>(
        `/api/brands/${brandId}/publishing/accounts`,
      );
      return body.accounts;
    },
  });
}

export function useCredentials(workspaceId: string | null): UseQueryResult<CredentialView[]> {
  return useQuery({
    queryKey: connectionKeys.credentials(workspaceId ?? 'none'),
    enabled: workspaceId !== null,
    queryFn: async () => {
      const body = await apiFetch<{ credentials: CredentialView[] }>(
        `/api/workspaces/${workspaceId}/credentials`,
      );
      return body.credentials;
    },
  });
}

export interface RevocationSummary {
  credentialId: string;
  accountsRevoked: number;
  targetsBlocked: number;
}

export function useRevokeCredential(workspaceId: string | null, brandId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { credentialId: string; reason?: string }) => {
      const body = await apiFetch<{ revoked: RevocationSummary }>(
        `/api/workspaces/${workspaceId}/credentials/${input.credentialId}/revoke`,
        { method: 'POST', body: { reason: input.reason } },
      );
      return body.revoked;
    },
    onSuccess: () => {
      // Both lists, because revoking a credential changes the status of accounts that are
      // fetched from a different endpoint. Invalidating only the credential list would
      // leave the accounts below it still reading ACTIVE.
      void queryClient.invalidateQueries({
        queryKey: connectionKeys.credentials(workspaceId ?? ''),
      });
      void queryClient.invalidateQueries({ queryKey: connectionKeys.accounts(brandId ?? '') });
    },
  });
}

/** Human label for a platform. Kept here so every surface spells them the same way. */
export const PLATFORM_LABELS: Record<PlatformName, string> = {
  X: 'X',
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  THREADS: 'Threads',
};

/**
 * What the user should actually *do* about a status.
 *
 * Deliberately not a straight enum-to-sentence map: `EXPIRED` and `REVOKED` look similar
 * in the database and need completely different actions from a human. An expired token
 * usually fixes itself on the next sweep; a revoked one never will, because somebody
 * removed the app at the platform end and only a reconnect brings it back.
 */
export function describeAccountStatus(connection: Connection): {
  tone: 'ok' | 'warn' | 'bad';
  title: string;
  action: string | null;
} {
  switch (connection.status) {
    case 'ACTIVE':
      return { tone: 'ok', title: 'Connected', action: null };
    case 'EXPIRED':
      return {
        tone: 'warn',
        title: 'Token expired',
        action: 'The hourly health check will try to refresh this. Reconnect if it persists.',
      };
    case 'REVOKED':
      return {
        tone: 'bad',
        title: 'Access revoked',
        action: 'Someone removed the app at the platform. Reconnect to publish again.',
      };
    case 'ERROR':
      return {
        tone: 'bad',
        title: 'Not working',
        action: connection.lastError ?? 'Reconnect this account.',
      };
    case 'DISCONNECTED':
    default:
      return { tone: 'warn', title: 'Disconnected', action: 'Reconnect to publish here.' };
  }
}
