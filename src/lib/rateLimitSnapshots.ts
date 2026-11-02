import type { RateLimitSnapshot } from '@/lib/api';

/** What `rate-limits:updated` carries: a fresh snapshot for one window, or
 *  word that the account no longer has a window (`removed`). */
export interface RateLimitUpdate {
  account_name?: string;
  snapshot?: RateLimitSnapshot;
  removed?: string;
}

/** Folds one `rate-limits:updated` payload into an account's snapshots,
 *  keyed by `rate_limit_type`. Returns `prev` itself when nothing changes. */
export function applyRateLimitUpdate(
  prev: Record<string, RateLimitSnapshot>,
  payload: RateLimitUpdate | undefined,
  accountName: string,
): Record<string, RateLimitSnapshot> {
  if (!payload || payload.account_name !== accountName) return prev;
  if (payload.snapshot) return { ...prev, [payload.snapshot.rate_limit_type]: payload.snapshot };
  if (payload.removed && payload.removed in prev) {
    const { [payload.removed]: _gone, ...rest } = prev;
    return rest;
  }
  return prev;
}
