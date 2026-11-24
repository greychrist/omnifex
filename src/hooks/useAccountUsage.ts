import type { SessionCostSnapshot, SubagentCost, UsageRunResult } from '@/lib/api';
import { useUsageAutoRefresh } from '@/hooks/useUsageAutoRefresh';
import { useSessionCost } from '@/hooks/useSessionCost';

export interface AccountUsage {
  data: UsageRunResult | null;
  loading: boolean;
  refresh: () => Promise<void>;
  sessionCost: SessionCostSnapshot | null;
  subagentCost: Record<string, SubagentCost> | null;
}

/** Call once per session view: `sessionCostUnwatch` stops the watcher outright, so a second owner unmounting freezes the other's cost. */
export function useAccountUsage(args: {
  accountName: string | null;
  hasCost: boolean;
  sessionActive: boolean;
  configDir?: string;
  projectPath?: string;
  sessionId?: string | null;
}): AccountUsage {
  const { data, loading, refresh } = useUsageAutoRefresh(args.accountName, args.sessionActive);
  const snapshot = useSessionCost({
    configDir: args.configDir,
    projectPath: args.projectPath,
    sessionId: args.sessionId,
    accountName: args.accountName ?? undefined,
  });
  return {
    data,
    loading,
    refresh,
    sessionCost: args.hasCost ? snapshot : null,
    subagentCost: snapshot?.bySubagent ?? null,
  };
}
