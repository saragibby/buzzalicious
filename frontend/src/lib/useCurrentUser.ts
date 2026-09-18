import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { fetchCurrentUser, type CurrentUser } from './api';

export const currentUserQueryKey = ['auth', 'me'] as const;

/**
 * The signed-in user, or `null`.
 *
 * `retry: false` matters: a 401 is a settled answer, not a transient failure, and
 * retrying it three times makes every signed-out page load slow for no reason.
 */
export function useCurrentUser(): UseQueryResult<CurrentUser | null> {
  return useQuery({
    queryKey: currentUserQueryKey,
    queryFn: fetchCurrentUser,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}
