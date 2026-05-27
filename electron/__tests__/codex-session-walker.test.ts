// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createCodexSessionWalker,
  type CodexSessionEntry,
} from '../services/codex-session-walker';

/**
 * Build an empty tmpdir we can populate with Codex-style rollouts. We don't
 * mirror Codex's real `<sessionsDir>/YYYY/MM/DD/` nesting in the fixtures —
 * the walker is documented as a "walk all .jsonl under sessionsDir" service,
 * so a mix of flat + nested files in the tests gives both shapes coverage.
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

/**
 * Write a rollout JSONL with the given lines and stamp it with a known mtime
 * so the recency sort assertions are deterministic regardless of write order.
 */
function writeRollout(
  filePath: string,
  lines: unknown[],
  mtimeIso: string,
): void {
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

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('returns [] when the sessionsDir does not exist', async () => {
    const walker = createCodexSessionWalker({
      sessionsDir: path.join(tmp.dir, 'nope-does-not-exist'),
    });
    const list = await walker.listSessions();
    expect(list).toEqual([]);
  });

  it('returns [] when the sessionsDir is empty', async () => {
    const walker = createCodexSessionWalker({ sessionsDir: tmp.dir });
    const list = await walker.listSessions();
    expect(list).toEqual([]);
  });

  it('discovers .jsonl files at any depth under sessionsDir', async () => {
    // One flat file + one nested under Codex's real YYYY/MM/DD layout.
    const flatId = '019cb5ad-0c36-7d80-b43f-559e40646c80';
    const nestedId = '019d1c78-c93c-7e10-807d-43a194215440';
    writeRollout(
      path.join(tmp.dir, `rollout-2026-03-03T16-49-02-${flatId}.jsonl`),
      [
        {
          type: 'session_meta',
          payload: { id: flatId, cwd: '/tmp/proj-flat' },
        },
      ],
      '2026-03-03T16:49:02.000Z',
    );
    writeRollout(
      path.join(
        tmp.dir,
        '2026',
        '03',
        '23',
        `rollout-2026-03-23T16-52-51-${nestedId}.jsonl`,
      ),
      [
        {
          type: 'session_meta',
          payload: { id: nestedId, cwd: '/tmp/proj-nested' },
        },
      ],
      '2026-03-23T16:52:51.000Z',
    );

    const walker = createCodexSessionWalker({ sessionsDir: tmp.dir });
    const list = await walker.listSessions();
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.conversationId).sort()).toEqual(
      [flatId, nestedId].sort(),
    );
  });

  it('sorts by mtime DESC', async () => {
    const idOld = '019cb5ad-0c36-7d80-b43f-559e40646c80';
    const idMid = '019ca7e3-cd50-7ab1-af19-d8db564fc1ec';
    const idNew = '019d1c78-c93c-7e10-807d-43a194215440';
    writeRollout(
      path.join(tmp.dir, `rollout-old-${idOld}.jsonl`),
      [{ type: 'session_meta', payload: { id: idOld, cwd: '/x' } }],
      '2026-01-01T00:00:00.000Z',
    );
    writeRollout(
      path.join(tmp.dir, `rollout-mid-${idMid}.jsonl`),
      [{ type: 'session_meta', payload: { id: idMid, cwd: '/x' } }],
      '2026-03-01T00:00:00.000Z',
    );
    writeRollout(
      path.join(tmp.dir, `rollout-new-${idNew}.jsonl`),
      [{ type: 'session_meta', payload: { id: idNew, cwd: '/x' } }],
      '2026-05-01T00:00:00.000Z',
    );

    const walker = createCodexSessionWalker({ sessionsDir: tmp.dir });
    const list = await walker.listSessions();
    expect(list.map((e) => e.conversationId)).toEqual([idNew, idMid, idOld]);
  });

  it('extracts conversationId from the filename when the payload lacks one', async () => {
    // Filename pattern `rollout-<timestamp>-<uuid>.jsonl` — strip everything
    // up to the trailing UUID. This is the canonical Codex shape; the
    // payload-id fallback below covers anything weirder.
    const id = '019d1c78-c93c-7e10-807d-43a194215440';
    writeRollout(
      path.join(tmp.dir, `rollout-2026-03-23T16-52-51-${id}.jsonl`),
      // No payload.id — forces the walker to derive from the filename.
      [{ type: 'response_item', payload: { kind: 'message' } }],
      '2026-03-23T16:52:51.000Z',
    );

    const walker = createCodexSessionWalker({ sessionsDir: tmp.dir });
    const list = await walker.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].conversationId).toBe(id);
  });

  it('also accepts a plain "<uuid>.jsonl" filename shape', async () => {
    // Belt-and-suspenders: Codex's current naming is rollout-… but if it
    // ever ships a flat <uuid>.jsonl format, we shouldn't drop those rows.
    const id = '019cb5ad-0c36-7d80-b43f-559e40646c80';
    writeRollout(
      path.join(tmp.dir, `${id}.jsonl`),
      [{ type: 'session_meta', payload: { id, cwd: '/some/path' } }],
      '2026-02-01T00:00:00.000Z',
    );

    const walker = createCodexSessionWalker({ sessionsDir: tmp.dir });
    const list = await walker.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].conversationId).toBe(id);
  });

  it('extracts projectPath from a recognized payload field', async () => {
    const id = '019cb5ad-0c36-7d80-b43f-559e40646c80';
    writeRollout(
      path.join(tmp.dir, `rollout-${id}.jsonl`),
      [
        {
          type: 'session_meta',
          payload: { id, cwd: '/Users/example/project' },
        },
      ],
      '2026-04-01T00:00:00.000Z',
    );

    const walker = createCodexSessionWalker({ sessionsDir: tmp.dir });
    const [entry] = await walker.listSessions();
    expect(entry.projectPath).toBe('/Users/example/project');
  });

  it('falls back to project_path / working_directory when cwd is absent', async () => {
    // Different Codex builds (and other generic JSONL writers) have used
    // each of these field names for the working directory. We accept any
    // of them so the row still renders with a project label.
    const id1 = '019cb5ad-0c36-7d80-b43f-559e40646001';
    const id2 = '019cb5ad-0c36-7d80-b43f-559e40646002';
    writeRollout(
      path.join(tmp.dir, `rollout-${id1}.jsonl`),
      [{ type: 'session_meta', payload: { id: id1, project_path: '/p/one' } }],
      '2026-04-01T00:00:00.000Z',
    );
    writeRollout(
      path.join(tmp.dir, `rollout-${id2}.jsonl`),
      [
        {
          type: 'session_meta',
          payload: { id: id2, working_directory: '/p/two' },
        },
      ],
      '2026-04-02T00:00:00.000Z',
    );

    const walker = createCodexSessionWalker({ sessionsDir: tmp.dir });
    const list = await walker.listSessions();
    const byId = new Map(list.map((e) => [e.conversationId, e.projectPath]));
    expect(byId.get(id1)).toBe('/p/one');
    expect(byId.get(id2)).toBe('/p/two');
  });

  it('leaves projectPath = null when no recognized field is present', async () => {
    const id = '019cb5ad-0c36-7d80-b43f-559e40646c80';
    writeRollout(
      path.join(tmp.dir, `rollout-${id}.jsonl`),
      [{ type: 'response_item', payload: { kind: 'message' } }],
      '2026-04-01T00:00:00.000Z',
    );

    const walker = createCodexSessionWalker({ sessionsDir: tmp.dir });
    const [entry] = await walker.listSessions();
    expect(entry.projectPath).toBeNull();
  });

  it('skips malformed JSONL files without throwing the whole walker', async () => {
    const goodId = '019cb5ad-0c36-7d80-b43f-559e40646c80';
    const badId = '019d1c78-c93c-7e10-807d-43a194215440';
    writeRollout(
      path.join(tmp.dir, `rollout-${goodId}.jsonl`),
      [{ type: 'session_meta', payload: { id: goodId, cwd: '/p/ok' } }],
      '2026-04-01T00:00:00.000Z',
    );
    // Garbage content — still a .jsonl file, but no valid JSON on line 1.
    writeRollout(
      path.join(tmp.dir, `rollout-${badId}.jsonl`),
      ['this is not json {{{{ broken'],
      '2026-04-02T00:00:00.000Z',
    );

    const walker = createCodexSessionWalker({ sessionsDir: tmp.dir });
    const list = await walker.listSessions();
    // Both files are surfaced — the malformed one keeps its filename-derived
    // conversationId and a null projectPath, the walker just shouldn't throw.
    expect(list).toHaveLength(2);
    const good = list.find((e: CodexSessionEntry) => e.conversationId === goodId);
    const bad = list.find((e: CodexSessionEntry) => e.conversationId === badId);
    expect(good?.projectPath).toBe('/p/ok');
    expect(bad?.projectPath).toBeNull();
  });

  it('exposes the absolute jsonlPath and ISO lastActivity on each entry', async () => {
    const id = '019cb5ad-0c36-7d80-b43f-559e40646c80';
    const filePath = path.join(tmp.dir, `rollout-${id}.jsonl`);
    writeRollout(
      filePath,
      [{ type: 'session_meta', payload: { id, cwd: '/p' } }],
      '2026-04-15T12:00:00.000Z',
    );

    const walker = createCodexSessionWalker({ sessionsDir: tmp.dir });
    const [entry] = await walker.listSessions();
    expect(entry.jsonlPath).toBe(filePath);
    // lastActivity is an ISO string — round-tripping via Date keeps the
    // test resilient to OS-level mtime precision differences.
    expect(new Date(entry.lastActivity).toISOString()).toBe(
      '2026-04-15T12:00:00.000Z',
    );
  });
});
