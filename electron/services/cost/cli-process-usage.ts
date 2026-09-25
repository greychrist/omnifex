// Cost module — the CLI's own running token totals, per CLI process.
//
// The transcript is not the whole bill. The CLI runs some model calls with
// `skipTranscript` — side questions (`/btw`), session-title generation — and
// none of them reach a JSONL, so the transcript-derived Cost Report never saw
// them. The CLI does count them: every `result` carries `modelUsage`, its
// running per-model totals for the process, and `get_usage` returns the same
// figures on demand.
//
// A process's totals are not guaranteed to start at zero. `--resume` restores
// the totals an earlier process saved in its `cost-state` record — when that
// record exists. So each process records a BASELINE before it spends anything
// and then its LATEST figure; latest − baseline is exactly what the process
// spent, whichever way the restore went. `unlogged-spend.ts` turns that into
// cost rows. See docs/superpowers/specs/2026-09-25-side-chat-design.md, "Cost".

import type { Database } from '../database';

/** One model's running totals, as the CLI reports them (camelCase on the wire). */
export interface CliModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** Keyed by the CLI's model id, e.g. `claude-opus-5-5[1m]`. */
export type CliModelUsage = Record<string, CliModelTotals>;

export interface CliUsageEvent {
  /** The CLI session id — the transcript's file name. */
  sessionId: string;
  /** One CLI process. A restart or resume is a new process. */
  processId: string;
  /** ISO. When the process was spawned; its transcript window starts here. */
  startedAt: string;
  phase: 'baseline' | 'latest';
  /** ISO. When the figure was read. */
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
  /** Every recorded process, grouped by session, oldest first. */
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
