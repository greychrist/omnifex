import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { createDatabase } from '../services/database';
import { createSessionCostService } from '../services/cost/session-cost';
import { createCostHistoryService } from '../services/cost/cost-history';
import type { CostFs } from '../services/cost/transcript-usage';
import { computeSessionCost, type SessionCostDailyRow } from '../services/cost/session-cost-core';
import { extractDedupedUsage, foldUsage, newUsageFold } from '../services/cost/usage-extract';

const CFG = '/cfg';
const PROJECT = '/Users/me/proj';
const PROJECTS_DIR = path.join(CFG, 'projects');
const PROJECT_DIR = path.join(PROJECTS_DIR, '-Users-me-proj');
const SESSION_FILE = path.join(PROJECT_DIR, 'sess1.jsonl');
const SUBAGENTS_DIR = path.join(PROJECT_DIR, 'sess1', 'subagents');
const AGENT_FILE = path.join(SUBAGENTS_DIR, 'agent-x.jsonl');
const WF_AGENT_FILE = path.join(SUBAGENTS_DIR, 'workflows', 'wf_1', 'agent-y.jsonl');

const args = { configDir: CFG, projectPath: PROJECT, sessionId: 'sess1', accountName: 'Work' };

function assistant(opts: { req?: string; msg?: string; out: number; model?: string; ts?: string; cwd?: string }): string {
  const rec: Record<string, unknown> = {
    type: 'assistant',
    timestamp: opts.ts ?? '2026-07-17T01:00:00Z',
    message: { model: opts.model ?? 'claude-opus-4-8', usage: { output_tokens: opts.out, input_tokens: 3 } },
  };
  if (opts.req) rec.requestId = opts.req;
  if (opts.msg) (rec.message as Record<string, unknown>).id = opts.msg;
  if (opts.cwd) rec.cwd = opts.cwd;
  return JSON.stringify(rec);
}

function makeWorld() {
  const files: Record<string, string> = {};
  const mtimes: Record<string, number> = {};
  let clock = 1;
  const touch = (p: string, content: string) => { files[p] = content; mtimes[p] = clock++; };
  const counters = { bytes: 0, reads: 0 };
  const listDir = (p: string): { name: string; isDirectory: boolean }[] => {
    const prefix = p + path.sep;
    const names = new Map<string, boolean>();
    for (const f of Object.keys(files)) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length).split(path.sep);
      names.set(rest[0], rest.length > 1 || names.get(rest[0]) === true);
    }
    return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
  };
  const fsDeps: CostFs = {
    listDir,
    stat: (p) => (p in files ? { size: Buffer.byteLength(files[p]), mtimeMs: mtimes[p] } : null),
    readRange: async (p, start, end) => {
      if (!(p in files)) return null;
      const buf = Buffer.from(files[p]).subarray(start, end);
      counters.bytes += buf.length;
      counters.reads += 1;
      return buf;
    },
  };
  return { files, touch, fsDeps, counters };
}

function fromScratch(world: ReturnType<typeof makeWorld>) {
  const subagentFiles = Object.keys(world.files)
    .filter((p) => p.startsWith(SUBAGENTS_DIR + path.sep) && path.basename(p).startsWith('agent-'))
    .sort()
    .map((p) => ({ agentId: path.basename(p).slice('agent-'.length, -'.jsonl'.length), content: world.files[p] }));
  return computeSessionCost({
    sessionContent: world.files[SESSION_FILE] ?? '',
    subagentFiles,
    sessionId: 'sess1',
    accountName: 'Work',
    configDir: CFG,
    projectPath: PROJECT,
    overrides: undefined,
  });
}

describe('foldUsage', () => {
  it('folding a transcript in arbitrary pieces yields exactly extractDedupedUsage', () => {
    const lines = [
      assistant({ req: 'r1', out: 10 }),
      '',
      assistant({ out: 7 }), // no request or message id: keyed by line number
      assistant({ req: 'r2', out: 20 }),
      'not json',
      assistant({ req: 'r1', out: 11 }), // re-observed: last wins, moves to the end
      assistant({ msg: 'm9', out: 5 }),
      assistant({ out: 8 }),
    ];
    const content = lines.join('\n');
    const expected = extractDedupedUsage(content);

    for (let cut = 0; cut <= content.length; cut += 13) {
      const fold = newUsageFold();
      const first = content.slice(0, cut);
      const nl = first.lastIndexOf('\n');
      if (nl >= 0) foldUsage(fold, first.slice(0, nl), { tailIsPartial: false });
      const resumeAt = nl + 1;
      foldUsage(fold, first.slice(resumeAt), { tailIsPartial: true });
      foldUsage(fold, content.slice(resumeAt), { tailIsPartial: true });
      expect([...fold.rows.values()]).toEqual(expected);
    }
  });
});

describe('live cost watcher (incremental)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('after appends, partial lines and new subagents, every emission equals a from-scratch compute', async () => {
    vi.useFakeTimers();
    const world = makeWorld();
    world.touch(SESSION_FILE, assistant({ req: 'r1', out: 1000 }) + '\n');
    const upserts: SessionCostDailyRow[][] = [];
    const emitted: unknown[] = [];
    const svc = createSessionCostService({
      sendToRenderer: (_c, p) => emitted.push(p),
      costHistory: { replaceSession: (_id: string, rows: SessionCostDailyRow[]) => upserts.push(rows) } as never,
      getOverrides: () => undefined,
      fs: world.fsDeps,
      pollMs: 1000,
    });

    const initial = await svc.watch(args);
    expect(initial).toEqual(fromScratch(world).snapshot);

    const steps: (() => void)[] = [
      // A whole line plus half of the next one (the CLI mid-write).
      () => world.touch(SESSION_FILE, world.files[SESSION_FILE] + assistant({ req: 'r2', out: 50 }) + '\n' + '{"type":"assis'),
      () => world.touch(SESSION_FILE, world.files[SESSION_FILE].replace(/\{"type":"assis$/, assistant({ req: 'r3', out: 9 })) + '\n' + assistant({ req: 'r2', out: 60 }) + '\n'),
      () => {
        world.touch(SESSION_FILE, world.files[SESSION_FILE] + assistant({ out: 4 }) + '\n');
        world.touch(AGENT_FILE, assistant({ req: 'r2', out: 60 }) + '\n' + assistant({ req: 'a1', out: 300, model: 'claude-haiku-4-5' }) + '\n');
      },
      // A nested workflow agent, and the main loop later claims a request the
      // subagent held first — the main loop owns it from then on.
      () => {
        world.touch(WF_AGENT_FILE, assistant({ req: 'w1', out: 70, ts: '2026-07-18T02:00:00Z' }));
        world.touch(SESSION_FILE, world.files[SESSION_FILE] + assistant({ req: 'a1', out: 300, model: 'claude-haiku-4-5' }) + '\n');
      },
      () => world.touch(WF_AGENT_FILE, world.files[WF_AGENT_FILE] + '\n' + assistant({ out: 2, ts: '2026-07-18T02:01:00Z' }) + '\n'),
    ];

    for (const step of steps) {
      step();
      const before = emitted.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(emitted.length).toBe(before + 1);
      const expected = fromScratch(world);
      expect(emitted.at(-1)).toEqual(expected.snapshot);
      expect(upserts.at(-1)).toEqual(expected.dailyRows);
    }
    svc.stopAll();
  });

  it('a grown transcript costs only its appended bytes; a rewritten one is read again from the start', async () => {
    vi.useFakeTimers();
    const world = makeWorld();
    const big = Array.from({ length: 200 }, (_, i) => assistant({ req: `r${i}`, out: 1 })).join('\n') + '\n';
    world.touch(SESSION_FILE, big);
    const svc = createSessionCostService({
      sendToRenderer: () => {},
      costHistory: null,
      getOverrides: () => undefined,
      fs: world.fsDeps,
      pollMs: 1000,
    });
    await svc.watch(args);
    expect(world.counters.bytes).toBe(Buffer.byteLength(big));

    world.counters.bytes = 0;
    world.counters.reads = 0;
    await vi.advanceTimersByTimeAsync(3000);
    expect(world.counters.bytes).toBe(0);

    const extra = assistant({ req: 'new', out: 5 }) + '\n';
    world.touch(SESSION_FILE, big + extra);
    await vi.advanceTimersByTimeAsync(1000);
    expect(world.counters.bytes).toBe(Buffer.byteLength(extra));
    expect(world.counters.reads).toBe(1);

    world.counters.bytes = 0;
    world.touch(SESSION_FILE, (big + extra).replace('"r0"', '"q0"'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(world.counters.bytes).toBe(Buffer.byteLength(big + extra));
    svc.stopAll();
  });

  it('never runs two refreshes for one session at once', async () => {
    vi.useFakeTimers();
    const world = makeWorld();
    world.touch(SESSION_FILE, assistant({ req: 'r1', out: 1 }) + '\n');
    let inFlight = 0;
    let maxInFlight = 0;
    let release: (() => void) | null = null;
    let slow = false;
    const gatedFs: CostFs = {
      ...world.fsDeps,
      readRange: async (p, s, e) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (slow) await new Promise<void>((r) => { release = r; });
          return await world.fsDeps.readRange(p, s, e);
        } finally {
          inFlight -= 1;
        }
      },
    };
    const emitted: unknown[] = [];
    const svc = createSessionCostService({
      sendToRenderer: (_c, p) => emitted.push(p),
      costHistory: null,
      getOverrides: () => undefined,
      fs: gatedFs,
      pollMs: 1000,
    });
    await svc.watch(args);

    slow = true;
    world.touch(SESSION_FILE, world.files[SESSION_FILE] + assistant({ req: 'r2', out: 1 }) + '\n');
    await vi.advanceTimersByTimeAsync(5000); // five ticks while the read hangs
    expect(maxInFlight).toBe(1);
    slow = false;
    release!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual(fromScratch(world).snapshot);
    svc.stopAll();
  });

  it('an in-flight refresh finishing after unwatch emits nothing', async () => {
    vi.useFakeTimers();
    const world = makeWorld();
    world.touch(SESSION_FILE, assistant({ req: 'r1', out: 1 }) + '\n');
    let release: (() => void) | null = null;
    let slow = false;
    const gatedFs: CostFs = {
      ...world.fsDeps,
      readRange: async (p, s, e) => {
        if (slow) await new Promise<void>((r) => { release = r; });
        return world.fsDeps.readRange(p, s, e);
      },
    };
    const emitted: unknown[] = [];
    const svc = createSessionCostService({
      sendToRenderer: (_c, p) => emitted.push(p),
      costHistory: null,
      getOverrides: () => undefined,
      fs: gatedFs,
      pollMs: 1000,
    });
    await svc.watch(args);
    slow = true;
    world.touch(SESSION_FILE, world.files[SESSION_FILE] + assistant({ req: 'r2', out: 1 }) + '\n');
    await vi.advanceTimersByTimeAsync(1000);
    svc.unwatch('sess1');
    release!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitted).toHaveLength(0);
  });
});

describe('cost-history backfill (async, persisted)', () => {
  function seed(world: ReturnType<typeof makeWorld>) {
    world.touch(SESSION_FILE, [
      JSON.stringify({ type: 'user', cwd: '/Users/me/real-proj' }),
      assistant({ req: 'r1', out: 1000 }),
      assistant({ req: 'r2', out: 10, ts: '2026-07-18T03:00:00Z' }),
    ].join('\n'));
    world.touch(AGENT_FILE, assistant({ req: 'r2', out: 10 }) + '\n' + assistant({ req: 'a1', out: 500, model: 'claude-haiku-4-5' }));
    world.touch(path.join(PROJECT_DIR, 'sess2.jsonl'), assistant({ req: 'z', out: 42, model: 'claude-sonnet-5' }) + '\n');
  }
  const accounts = [{ name: 'Work', config_dir: CFG }];
  const rows = (db: ReturnType<typeof createDatabase>) =>
    db.raw.prepare('SELECT * FROM session_cost_daily ORDER BY session_id, date, model, is_subagent').all() as (SessionCostDailyRow & { updated_at: string })[];

  it('writes exactly the rows computeSessionCost produces', async () => {
    const db = createDatabase(':memory:');
    const world = makeWorld();
    seed(world);
    const r = await createCostHistoryService(db, world.fsDeps).backfill(accounts);
    expect(r.sessionsScanned).toBe(2);
    const expected = computeSessionCost({
      sessionContent: world.files[SESSION_FILE],
      subagentFiles: [{ agentId: 'x', content: world.files[AGENT_FILE] }],
      sessionId: 'sess1',
      accountName: 'Work',
      configDir: CFG,
      projectPath: '/Users/me/real-proj',
      overrides: undefined,
    }).dailyRows;
    const got = rows(db).filter((x) => x.session_id === 'sess1').map(({ updated_at: _u, internal_kind: _k, ...rest }) => rest);
    const sortKey = (x: SessionCostDailyRow) => `${x.date}|${x.model}|${x.is_subagent}`;
    expect(got).toEqual([...expected].sort((a, b) => sortKey(a).localeCompare(sortKey(b))));
    db.close();
  });

  it('a restarted daemon (new service, same database) re-reads only what changed', async () => {
    const db = createDatabase(':memory:');
    const world = makeWorld();
    seed(world);
    expect((await createCostHistoryService(db, world.fsDeps).backfill(accounts)).sessionsScanned).toBe(2);
    const before = rows(db);

    world.counters.bytes = 0;
    expect((await createCostHistoryService(db, world.fsDeps).backfill(accounts)).sessionsScanned).toBe(0);
    expect(world.counters.bytes).toBe(0);
    expect(rows(db)).toEqual(before);

    world.touch(path.join(PROJECT_DIR, 'sess2.jsonl'), world.files[path.join(PROJECT_DIR, 'sess2.jsonl')] + assistant({ req: 'z2', out: 1 }) + '\n');
    expect((await createCostHistoryService(db, world.fsDeps).backfill(accounts)).sessionsScanned).toBe(1);
    db.close();
  });

  it('a pricing change re-prices every session even though no transcript changed', async () => {
    const db = createDatabase(':memory:');
    const world = makeWorld();
    seed(world);
    await createCostHistoryService(db, world.fsDeps).backfill(accounts);
    db.raw.prepare("INSERT INTO model_pricing (pattern, effective_from, output_per_m) VALUES ('claude-sonnet-5', '2020-01-01', 1)").run();
    expect((await createCostHistoryService(db, world.fsDeps).backfill(accounts)).sessionsScanned).toBe(2);
    db.close();
  });

  it('overlapping calls share one sweep', async () => {
    const db = createDatabase(':memory:');
    const world = makeWorld();
    seed(world);
    const svc = createCostHistoryService(db, world.fsDeps);
    const [a, b] = await Promise.all([svc.backfill(accounts), svc.backfill(accounts)]);
    expect(a).toBe(b);
    expect(a.sessionsScanned).toBe(2);
    db.close();
  });

  // EnterWorktree leaves one session id in two project dirs; the last in listing
  // order must win.
  it('a session id held by two project dirs resolves to the later dir, however the reads interleave', async () => {
    const db = createDatabase(':memory:');
    const world = makeWorld();
    const first = path.join(PROJECTS_DIR, '-a', 'dup.jsonl');
    const second = path.join(PROJECTS_DIR, '-b', 'dup.jsonl');
    world.touch(first, assistant({ req: 'x', out: 111 }) + '\n');
    world.touch(second, assistant({ req: 'y', out: 222 }) + '\n');
    let releaseFirst: (() => void) | null = null;
    const gated: CostFs = {
      ...world.fsDeps,
      readRange: async (p, s, e) => {
        if (p === first) await new Promise<void>((r) => { releaseFirst = r; setTimeout(r, 20); });
        return world.fsDeps.readRange(p, s, e);
      },
    };
    await createCostHistoryService(db, gated).backfill(accounts);
    expect(releaseFirst).not.toBeNull();
    const out = db.raw.prepare("SELECT output_tokens FROM session_cost_daily WHERE session_id = 'dup'").all();
    expect(out).toEqual([{ output_tokens: 222 }]);
    db.close();
  });

  it('a change to the earlier dir alone still leaves the later dir\'s rows', async () => {
    const db = createDatabase(':memory:');
    const world = makeWorld();
    const first = path.join(PROJECTS_DIR, '-a', 'dup.jsonl');
    const second = path.join(PROJECTS_DIR, '-b', 'dup.jsonl');
    world.touch(first, assistant({ req: 'x', out: 111 }) + '\n');
    world.touch(second, assistant({ req: 'y', out: 222 }) + '\n');
    await createCostHistoryService(db, world.fsDeps).backfill(accounts);
    world.touch(first, world.files[first] + assistant({ req: 'x2', out: 1 }) + '\n');
    await createCostHistoryService(db, world.fsDeps).backfill(accounts);
    const out = db.raw.prepare("SELECT output_tokens FROM session_cost_daily WHERE session_id = 'dup'").all();
    expect(out).toEqual([{ output_tokens: 222 }]);
    db.close();
  });
});
