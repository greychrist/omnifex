const TAB_SCOPED_PREFIXES = [
  // New (Task 24 rename): main process emits on these for interactive
  // tab-scoped sessions.
  'agent-output:',
  'agent-error:',
  'agent-complete:',
  // Legacy (still allow-listed for the one-release compat shim — preload
  // forwards legacy subscribers to the new channels, but if any code path
  // happens to still emit on the old name it should still route correctly).
  'claude-output:',
  'claude-error:',
  'claude-complete:',
  'claude-subagent:',
  'claude-compact:',
  'elicitation-request:',
];

// Run-scoped channels share the `agent-*:` prefix with the renamed
// tab-scoped channels. resolveTarget() checks tab owners first, then run
// owners, so `agent-output:<tabId>` and `agent-output:<runId>` both
// resolve correctly as long as tabIds and runIds don't collide (tabIds
// are UUIDs, runIds are numeric strings — no collision).
const RUN_SCOPED_PREFIXES = [
  'agent-output:',
  'agent-error:',
  'agent-complete:',
  'agent-cancelled:',
];

export type RouteTarget =
  | { kind: 'owner'; ownerId: number }
  | { kind: 'broadcast' };

export interface WindowRouter {
  registerTabOwner(tabId: string, ownerId: number): void;
  unregisterTabOwner(tabId: string): void;
  registerRunOwner(runId: string, ownerId: number): void;
  unregisterRunOwner(runId: string): void;
  resolveTarget(channel: string): RouteTarget;
}

function extractSuffix(prefixes: string[], channel: string): string | null {
  for (const p of prefixes) {
    if (channel.startsWith(p)) return channel.slice(p.length);
  }
  return null;
}

export function createWindowRouter(): WindowRouter {
  const tabOwners = new Map<string, number>();
  const runOwners = new Map<string, number>();

  return {
    registerTabOwner(tabId, ownerId) {
      tabOwners.set(tabId, ownerId);
    },
    unregisterTabOwner(tabId) {
      tabOwners.delete(tabId);
    },
    registerRunOwner(runId, ownerId) {
      runOwners.set(runId, ownerId);
    },
    unregisterRunOwner(runId) {
      runOwners.delete(runId);
    },
    resolveTarget(channel) {
      const tabId = extractSuffix(TAB_SCOPED_PREFIXES, channel);
      if (tabId !== null) {
        const ownerId = tabOwners.get(tabId);
        if (ownerId !== undefined) return { kind: 'owner', ownerId };
      }
      const runId = extractSuffix(RUN_SCOPED_PREFIXES, channel);
      if (runId !== null) {
        const ownerId = runOwners.get(runId);
        if (ownerId !== undefined) return { kind: 'owner', ownerId };
      }
      return { kind: 'broadcast' };
    },
  };
}
