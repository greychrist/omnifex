import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { createDatabase, type Database } from '../services/database';
import {
  createCostHistoryService,
  collectSubagentFiles,
  type CostFs,
} from '../services/cost/cost-history';
import type { SessionCostDailyRow } from '../services/cost/session-cost-core';

/**
 * The CLI writes subagent transcripts at two depths:
 *   <session>/subagents/agent-<id>.jsonl                    — plain Task subagents
 *   <session>/subagents/workflows/wf_<id>/agent-<id>.jsonl  — Workflow subagents
 *
 * A non-recursive listing of `subagents/` sees only the first, silently
 * dropping every workflow agent's cost. Measured on ~/.claude-work for
 * 2026-08 that was 16 files and $37.41 — see
 * docs/superpowers/specs/2026-08-26-cost-report-page-design.md §1.1.
 */

const CFG = '/cfg';
const PROJ_DIR = path.join(CFG, 'projects', '-Users-me-proj');
const SUBAGENTS = path.join(PROJ_DIR, 'sessA', 'subagents');
const WF_DIR = path.join(SUBAGENTS, 'workflows', 'wf_abc123');

function assistantLine(id: string, model: string, output: number, cwd = '/Users/me/proj'): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: `r-${id}`,
    timestamp: '2026-08-17T01:00:00Z',
    cwd,
    message: { id, model, usage: { output_tokens: output } },
  });
}

function world() {
  const files: Record<string, string> = {
    [path.join(PROJ_DIR, 'sessA.jsonl')]: assistantLine('m-main', 'claude-opus-4-8', 1000),
    [path.join(SUBAGENTS, 'agent-flat.jsonl')]: assistantLine('m-flat', 'claude-opus-4-8', 2000),
    [path.join(WF_DIR, 'agent-wf1.jsonl')]: assistantLine('m-wf1', 'claude-opus-4-8', 4000),
    [path.join(WF_DIR, 'agent-wf2.jsonl')]: assistantLine('m-wf2', 'claude-opus-4-8', 8000),
  };
  const dirs: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
    [path.join(CFG, 'projects')]: [{ name: '-Users-me-proj', isDirectory: true }],
    [PROJ_DIR]: [
      { name: 'sessA.jsonl', isDirectory: false },
      { name: 'sessA', isDirectory: true },
    ],
    [SUBAGENTS]: [
      { name: 'agent-flat.jsonl', isDirectory: false },
      { name: 'workflows', isDirectory: true },
    ],
    [path.join(SUBAGENTS, 'workflows')]: [{ name: 'wf_abc123', isDirectory: true }],
    [WF_DIR]: [
      { name: 'agent-wf1.jsonl', isDirectory: false },
      { name: 'agent-wf2.jsonl', isDirectory: false },
    ],
  };
  const fakeFs: CostFs = {
    readFile: (p) => files[p] ?? null,
    listDir: (p) => dirs[p] ?? [],
    stat: (p) => (p in files ? { mtimeMs: files[p].length, size: files[p].length } : null),
  };
  return { files, dirs, fakeFs };
}

describe('subagent transcript discovery', () => {
  let db: Database;
  beforeEach(() => { db = createDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  it('collectSubagentFiles finds agent-*.jsonl at any depth under subagents/', () => {
    const { fakeFs } = world();
    expect(collectSubagentFiles(fakeFs, SUBAGENTS).sort()).toEqual(
      [
        path.join(SUBAGENTS, 'agent-flat.jsonl'),
        path.join(WF_DIR, 'agent-wf1.jsonl'),
        path.join(WF_DIR, 'agent-wf2.jsonl'),
      ].sort(),
    );
  });

  it('backfill costs nested workflow subagents, not just the flat ones', () => {
    const { fakeFs } = world();
    const svc = createCostHistoryService(db, fakeFs);
    svc.backfill([{ name: 'Work', config_dir: CFG }]);

    const rows = db.raw
      .prepare('SELECT * FROM session_cost_daily')
      .all() as SessionCostDailyRow[];
    // 1000 (main) + 2000 (flat) + 4000 + 8000 (workflow) = 15000 output tokens.
    const output = rows.reduce((n, r) => n + r.output_tokens, 0);
    expect(output).toBe(15_000);
  });

  it('a new nested workflow file invalidates the change-detection signature', () => {
    const { files, dirs, fakeFs } = world();
    const svc = createCostHistoryService(db, fakeFs);
    expect(svc.backfill([{ name: 'Work', config_dir: CFG }]).sessionsScanned).toBe(1);
    expect(svc.backfill([{ name: 'Work', config_dir: CFG }]).sessionsScanned).toBe(0);

    // A workflow spawns another agent: same main file, same flat subagent,
    // one more file two levels down.
    files[path.join(WF_DIR, 'agent-wf3.jsonl')] = assistantLine('m-wf3', 'claude-opus-4-8', 16_000);
    dirs[WF_DIR].push({ name: 'agent-wf3.jsonl', isDirectory: false });

    expect(svc.backfill([{ name: 'Work', config_dir: CFG }]).sessionsScanned).toBe(1);
    const output = (db.raw.prepare('SELECT * FROM session_cost_daily').all() as SessionCostDailyRow[])
      .reduce((n, r) => n + r.output_tokens, 0);
    expect(output).toBe(31_000);
  });

  it('ignores non-agent files and does not recurse forever on empty dirs', () => {
    const { dirs, fakeFs } = world();
    dirs[WF_DIR].push({ name: 'notes.md', isDirectory: false });
    dirs[WF_DIR].push({ name: 'empty', isDirectory: true });
    expect(collectSubagentFiles(fakeFs, SUBAGENTS)).toHaveLength(3);
  });
});
