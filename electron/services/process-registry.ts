import type { ChildProcess } from 'node:child_process';

export interface ProcessRegistry {
  register(runId: number, process: ChildProcess): void;
  get(runId: number): ChildProcess | undefined;
  kill(runId: number): boolean;
  remove(runId: number): void;
  getAll(): Map<number, ChildProcess>;
  cleanup(): number[];
}

export function createProcessRegistry(): ProcessRegistry {
  const processes = new Map<number, ChildProcess>();

  return {
    register(runId, process) {
      processes.set(runId, process);
    },
    get(runId) {
      return processes.get(runId);
    },
    kill(runId) {
      const proc = processes.get(runId);
      if (!proc) return false;
      proc.kill('SIGTERM');
      processes.delete(runId);
      return true;
    },
    remove(runId) {
      processes.delete(runId);
    },
    getAll() {
      return processes;
    },
    cleanup() {
      const cleaned: number[] = [];
      for (const [runId, proc] of processes) {
        if (proc.exitCode !== null || proc.killed) {
          processes.delete(runId);
          cleaned.push(runId);
        }
      }
      return cleaned;
    },
  };
}
