import type { Query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Agent run registry — tracks in-flight SDK Query handles for agent
 * executions by runId, with explicit status state. Replaces the old
 * ProcessRegistry which was tightly typed to `ChildProcess` from the
 * Tauri-era raw-spawn path.
 *
 * The SDK's Query object doesn't expose a `killed` / `exitCode` surface
 * like ChildProcess does, so we track status as a string we update from
 * the stream listener: 'running' (initial) → 'completed' / 'failed' /
 * 'killed'. `cleanup()` removes any entry that isn't 'running'.
 */

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface AgentRunHandle {
  query: Query;
  status: AgentRunStatus;
}

export interface AgentRunRegistry {
  register(runId: number, handle: AgentRunHandle): void;
  get(runId: number): AgentRunHandle | undefined;
  /** Mark as killed and call query.close(). Returns true if the run was registered. */
  kill(runId: number): boolean;
  /** Set the status on an existing entry. No-op if the run isn't registered. */
  setStatus(runId: number, status: AgentRunStatus): void;
  remove(runId: number): void;
  getAll(): Map<number, AgentRunHandle>;
  /** Remove any entries whose status is not 'running'. Returns the removed runIds. */
  cleanup(): number[];
}

export function createAgentRunRegistry(): AgentRunRegistry {
  const runs = new Map<number, AgentRunHandle>();

  return {
    register(runId, handle) {
      runs.set(runId, handle);
    },
    get(runId) {
      return runs.get(runId);
    },
    kill(runId) {
      const handle = runs.get(runId);
      if (!handle) return false;
      handle.status = 'killed';
      try {
        handle.query.close();
      } catch {
        // close() may throw if the query already ended; ignore
      }
      return true;
    },
    setStatus(runId, status) {
      const handle = runs.get(runId);
      if (!handle) return;
      handle.status = status;
    },
    remove(runId) {
      runs.delete(runId);
    },
    getAll() {
      return runs;
    },
    cleanup() {
      const cleaned: number[] = [];
      for (const [runId, handle] of runs) {
        if (handle.status !== 'running') {
          runs.delete(runId);
          cleaned.push(runId);
        }
      }
      return cleaned;
    },
  };
}
