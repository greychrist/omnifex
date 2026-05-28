// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createCodexSessionWalker,
  type CodexSessionEntry,
} from '../services/codex-session-walker';
import type { Account } from '../services/accounts';

/**
 * Build an empty tmpdir that stands in for a Codex account's config dir. The
 * walker scans `<config_dir>/sessions`, so fixtures are written under a
 * `sessions/` subdir (mix of flat + nested files for shape coverage).
 */
function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-codex-walk-'));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

function codexAccount(id: number, configDir: string): Account {
  return {
    id,
    name: `Codex ${id}`,
    config_dir: configDir,
    engine: 'codex',
    subscription_label: '',
    has_cost: true,
    color: null,
    icon: null,
    cli_path: null,
    created_at: '',
    updated_at: '',
  };
}

function writeRollout(filePath: string, lines: unknown[], mtimeIso: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
  );
  const t = new Date(mtimeIso);
  fs.utimesSync(filePath, t, t);
}

describe('createCodexSessionWalker', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  /** Path to a rollout under this account's `sessions/` dir. */
  let sess: (p: string) => string;
  let walker: ReturnType<typeof createCodexSessionWalker>;

  beforeEach(() => {
    tmp = makeTmpDir();
    sess = (p: string) => path.join(tmp.dir, 'sessions', p);
    walker = createCodexSessionWalker({ listCodexAccounts: () => [codexAccount(1, tmp.dir)] });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('returns [] when the sessions dir does not exist', async () => {
    const w = createCodexSessionWalker({
      listCodexAccounts: () => [codexAccount(1, path.join(tmp.dir, 'nope-does-not-exist'))],
    });
    expect(await w.listSessions()).toEqual([]);
  });

  it('returns [] when the sessions dir is empty', async () => {
    fs.mkdirSync(path.join(tmp.dir, 'sessions'), { recursive: true });
    expect(await walker.listSessions()).toEqual([]);
  });

  it('discovers .jsonl files at any depth under sessions/', async () => {
    const flatId = '019cb5ad-0c36-7d80-b43f-559e40646c80';
    const nestedId = '019d1c78-c93c-7e10-807d-43a194215440';
    writeRollout(
      sess(`rollout-2026-03-03T16-49-02-${flatId}.jsonl`),
      [{ type: 'session_meta', payload: { id: flatId, cwd: '/tmp/proj-flat' } }],
      '2026-03-03T16:49:02.000Z',
    );
    writeRollout(
      sess(path.join('2026', '03', '23', `rollout-2026-03-23T16-52-51-${nestedId}.jsonl`)),
      [{ type: 'session_meta', payload: { id: nestedId, cwd: '/tmp/proj-nested' } }],
      '2026-03-23T16:52:51.000Z',
    );

    const list = await walker.listSessions();
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.conversationId).sort()).toEqual([flatId, nestedId].sort());
  });

  it('sorts by mtime DESC', async () => {
    const idOld = '019cb5ad-0c36-7d80-b43f-559e40646c80';
    const idMid = '019ca7e3-cd50-7ab1-af19-d8db564fc1ec';
    const idNew = '019d1c78-c93c-7e10-807d-43a194215440';
    writeRollout(sess(`rollout-old-${idOld}.jsonl`), [{ type: 'session_meta', payload: { id: idOld, cwd: '/x' } }], '2026-01-01T00:00:00.000Z');
    writeRollout(sess(`rollout-mid-${idMid}.jsonl`), [{ type: 'session_meta', payload: { id: idMid, cwd: '/x' } }], '2026-03-01T00:00:00.000Z');
    writeRollout(sess(`rollout-new-${idNew}.jsonl`), [{ type: 'session_meta', payload: { id: idNew, cwd: '/x' } }], '2026-05-01T00:00:00.000Z');

    const list = await walker.listSessions();
    expect(list.map((e) => e.conversationId)).toEqual([idNew, idMid, idOld]);
  });

  it('extracts conversationId from the filename when the payload lacks one', async () => {
    const id = '019d1c78-c93c-7e10-807d-43a194215440';
    writeRollout(
      sess(`rollout-2026-03-23T16-52-51-${id}.jsonl`),
      [{ type: 'response_item', payload: { kind: 'message' } }],
      '2026-03-23T16:52:51.000Z',
    );

    const list = await walker.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].conversationId).toBe(id);
  });

  it('also accepts a plain "<uuid>.jsonl" filename shape', async () => {
    const id = '019cb5ad-0c36-7d80-b43f-559e40646c80';
    writeRollout(sess(`${id}.jsonl`), [{ type: 'session_meta', payload: { id, cwd: '/some/path' } }], '2026-02-01T00:00:00.000Z');

    const list = await walker.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].conversationId).toBe(id);
  });

  it('extracts projectPath from a recognized payload field', async () => {
    const id = '019cb5ad-0c36-7d80-b43f-559e40646c80';
    writeRollout(sess(`rollout-${id}.jsonl`), [{ type: 'session_meta', payload: { id, cwd: '/Users/example/project' } }], '2026-04-01T00:00:00.000Z');

    const [entry] = await walker.listSessions();
    expect(entry.projectPath).toBe('/Users/example/project');
  });

  it('falls back to project_path / working_directory when cwd is absent', async () => {
    const id1 = '019cb5ad-0c36-7d80-b43f-559e40646001';
    const id2 = '019cb5ad-0c36-7d80-b43f-559e40646002';
    writeRollout(sess(`rollout-${id1}.jsonl`), [{ type: 'session_meta', payload: { id: id1, project_path: '/p/one' } }], '2026-04-01T00:00:00.000Z');
    writeRollout(sess(`rollout-${id2}.jsonl`), [{ type: 'session_meta', payload: { id: id2, working_directory: '/p/two' } }], '2026-04-02T00:00:00.000Z');

    const list = await walker.listSessions();
    const byId = new Map(list.map((e) => [e.conversationId, e.projectPath]));
    expect(byId.get(id1)).toBe('/p/one');
    expect(byId.get(id2)).toBe('/p/two');
  });

  it('leaves projectPath = null when no recognized field is present', async () => {
    const id = '019cb5ad-0c36-7d80-b43f-559e40646c80';
    writeRollout(sess(`rollout-${id}.jsonl`), [{ type: 'response_item', payload: { kind: 'message' } }], '2026-04-01T00:00:00.000Z');

    const [entry] = await walker.listSessions();
    expect(entry.projectPath).toBeNull();
  });

  it('skips malformed JSONL files without throwing the whole walker', async () => {
    const goodId = '019cb5ad-0c36-7d80-b43f-559e40646c80';
    const badId = '019d1c78-c93c-7e10-807d-43a194215440';
    writeRollout(sess(`rollout-${goodId}.jsonl`), [{ type: 'session_meta', payload: { id: goodId, cwd: '/p/ok' } }], '2026-04-01T00:00:00.000Z');
    writeRollout(sess(`rollout-${badId}.jsonl`), ['this is not json {{{{ broken'], '2026-04-02T00:00:00.000Z');

    const list = await walker.listSessions();
    expect(list).toHaveLength(2);
    const good = list.find((e: CodexSessionEntry) => e.conversationId === goodId);
    const bad = list.find((e: CodexSessionEntry) => e.conversationId === badId);
    expect(good?.projectPath).toBe('/p/ok');
    expect(bad?.projectPath).toBeNull();
  });

  it('exposes the absolute jsonlPath and ISO lastActivity on each entry', async () => {
    const id = '019cb5ad-0c36-7d80-b43f-559e40646c80';
    const filePath = sess(`rollout-${id}.jsonl`);
    writeRollout(filePath, [{ type: 'session_meta', payload: { id, cwd: '/p' } }], '2026-04-15T12:00:00.000Z');

    const [entry] = await walker.listSessions();
    expect(entry.jsonlPath).toBe(filePath);
    expect(new Date(entry.lastActivity).toISOString()).toBe('2026-04-15T12:00:00.000Z');
  });
});

describe('createCodexSessionWalker — multi-account', () => {
  it('aggregates rollouts across every Codex account, tagged with source account id', async () => {
    const a = makeTmpDir();
    const b = makeTmpDir();
    writeRollout(
      path.join(a.dir, 'sessions', '2026', '05', 'rollout-019.jsonl'),
      [{ type: 'session_meta', payload: { id: '019', cwd: '/proj-a' } }],
      '2026-05-01T00:00:00.000Z',
    );
    writeRollout(
      path.join(b.dir, 'sessions', '2026', '05', 'rollout-020.jsonl'),
      [{ type: 'session_meta', payload: { id: '020', cwd: '/proj-b' } }],
      '2026-05-02T00:00:00.000Z',
    );

    const walker = createCodexSessionWalker({
      listCodexAccounts: () => [codexAccount(1, a.dir), codexAccount(2, b.dir)],
    });
    const sessions = await walker.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.conversationId === '019')?.accountId).toBe(1);
    expect(sessions.find((s) => s.conversationId === '020')?.accountId).toBe(2);

    a.cleanup();
    b.cleanup();
  });

  it('handles a Codex account with no sessions dir yet', async () => {
    const walker = createCodexSessionWalker({
      listCodexAccounts: () => [codexAccount(1, '/nonexistent/.codex')],
    });
    expect(await walker.listSessions()).toEqual([]);
  });
});
