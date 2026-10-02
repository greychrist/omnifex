import type { SessionCostSnapshot, UsageRunResult } from '@/lib/api';
import { useUsageAutoRefresh } from '@/hooks/useUsageAutoRefresh';
import { useSessionCost } from '@/hooks/useSessionCost';

/** What the account widget and the `account` readout show and open. */
export interface AccountUsage {
  /** The scraped `/usage` result behind the usage popover. */
  data: UsageRunResult | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Computed cost of this session; null unless the account is cost-based. */
  sessionCost: SessionCostSnapshot | null;
}

/**
 * The session's account usage, fetched once per session view.
 *
 * Called by AgentSession and handed to both the account widget and the status
 * bar readout rather than called by each: `sessionCostUnwatch` stops the
 * main-process watcher for a session outright, not one subscriber's share of
 * it, so a second owner unmounting would silently freeze the other's cost.
 */
export function useAccountUsage(args: {
  accountName: string | null;
  hasCost: boolean;
  sessionActive: boolean;
  configDir?: string;
  projectPath?: string;
  sessionId?: string | null;
}): AccountUsage {
  const { data, loading, refresh } = useUsageAutoRefresh(args.accountName, args.sessionActive);
  // Cost-based accounts (Enterprise/API) are billed per token and expose no
  // rate-limit windows, so only they get a dollar figure.
  const sessionCost = useSessionCost({
    enabled: args.hasCost,
    configDir: args.configDir,
    projectPath: args.projectPath,
    sessionId: args.sessionId,
    accountName: args.accountName ?? undefined,
  });
  return { data, loading, refresh, sessionCost };
}
