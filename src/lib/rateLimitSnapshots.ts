import type { RateLimitSnapshot } from '@/lib/api';

/** `removed`: the account no longer has that window. */
export interface RateLimitUpdate {
  account_name?: string;
  snapshot?: RateLimitSnapshot;
  removed?: string;
}

export function applyRateLimitUpdate(
  prev: Record<string, RateLimitSnapshot>,
  payload: RateLimitUpdate | undefined,
  accountName: string,
): Record<string, RateLimitSnapshot> {
  if (payload?.account_name !== accountName) return prev;
  if (payload.snapshot) return { ...prev, [payload.snapshot.rate_limit_type]: payload.snapshot };
  if (payload.removed && payload.removed in prev) {
    const { [payload.removed]: _gone, ...rest } = prev;
    return rest;
  }
  return prev;
}
