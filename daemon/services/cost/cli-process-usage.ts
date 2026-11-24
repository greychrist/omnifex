// `--resume` restores earlier totals, so record a baseline before any spend: latest − baseline is what the process spent.

import type { Database } from '../database';

export interface CliModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Absent from older CLIs; counts only turns a recording version ran. */
  cacheCreationEphemeral1hInputTokens?: number;
}

export type CliModelUsage = Record<string, CliModelTotals>;

export interface CliUsageEvent {
  sessionId: string;
  /** A restart or resume is a new process. */
  processId: string;
  startedAt: string;
  phase: 'baseline' | 'latest';
  at: string;
  modelUsage: CliModelUsage;
}

export interface CliProcessUsage {
  sessionId: string;
  processId: string;
  startedAt: string;
  baseline: CliModelUsage | null;
  baselineAt: string | null;
  latest: CliModelUsage | null;
  latestAt: string | null;
}

export interface CliProcessUsageStore {
  record(event: CliUsageEvent): void;
  listBySession(): Map<string, CliProcessUsage[]>;
}

interface Row {
  session_id: string;
  process_id: string;
  started_at: string;
  baseline_json: string | null;
  baseline_at: string | null;
  latest_json: string | null;
  latest_at: string | null;
}

function parse(json: string | null): CliModelUsage | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as CliModelUsage;
  } catch {
    return null;
  }
}

export function createCliProcessUsageStore(db: Database): CliProcessUsageStore {
  const upsert = {
    baseline: db.raw.prepare(`
      INSERT INTO cli_process_usage (session_id, process_id, started_at, baseline_json, baseline_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (session_id, process_id)
      DO UPDATE SET baseline_json = excluded.baseline_json, baseline_at = excluded.baseline_at
    `),
    latest: db.raw.prepare(`
      INSERT INTO cli_process_usage (session_id, process_id, started_at, latest_json, latest_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (session_id, process_id)
      DO UPDATE SET latest_json = excluded.latest_json, latest_at = excluded.latest_at
    `),
  };
  const all = db.raw.prepare('SELECT * FROM cli_process_usage ORDER BY session_id, started_at');

  return {
    record(e) {
      upsert[e.phase].run(e.sessionId, e.processId, e.startedAt, JSON.stringify(e.modelUsage), e.at);
    },
    listBySession() {
      const out = new Map<string, CliProcessUsage[]>();
      for (const r of all.all() as Row[]) {
        const list = out.get(r.session_id) ?? [];
        list.push({
          sessionId: r.session_id,
          processId: r.process_id,
          startedAt: r.started_at,
          baseline: parse(r.baseline_json),
          baselineAt: r.baseline_at,
          latest: parse(r.latest_json),
          latestAt: r.latest_at,
        });
        out.set(r.session_id, list);
      }
      return out;
    },
  };
}
