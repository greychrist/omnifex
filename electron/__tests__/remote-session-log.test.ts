import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionLog, type SessionLog, type SessionMeta } from '../remote/session-log';

const META: SessionMeta = {
  sessionId: 's1',
  projectId: 'p1',
  projectPath: '/Users/greg/Repos/omnifex',
  configDir: '/Users/greg/.claude-personal',
  agent: 'claude',
  mode: 'rich',
  options: {},
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
};

const transcript = (n: number) => ({
  type: 'event' as const,
  sessionId: 's1',
  kind: 'transcript' as const,
  payload: { n },
});

describe('remote session log', () => {
  let root: string;
  let log: SessionLog;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omnifex-session-log-'));
    log = createSessionLog({ root, ringSize: 3 });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('assigns seq from 1, monotonic per session', () => {
    log.open(META);
    const a = log.append(transcript(1));
    const b = log.append(transcript(2));
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(log.lastSeq('s1')).toBe(2);
    // A second session has its own counter.
    log.open({ ...META, sessionId: 's2' });
    expect(log.append({ ...transcript(1), sessionId: 's2' }).seq).toBe(1);
  });

  it('refuses to append to a session that was never opened', () => {
    expect(() => log.append(transcript(1))).toThrow(/not open/);
  });

  it('replays everything after fromSeq from the ring', () => {
    log.open(META);
    for (let i = 1; i <= 3; i++) log.append(transcript(i));
    expect(log.replay('s1', 1).map((p) => p.seq)).toEqual([2, 3]);
    expect(log.replay('s1', 3)).toEqual([]);
    expect(log.replay('s1', 0).map((p) => p.seq)).toEqual([1, 2, 3]);
  });

  it('falls back to disk when fromSeq predates the ring', () => {
    // ringSize is 3, so seq 1 and 2 have been evicted by the time 5 lands.
    log.open(META);
    for (let i = 1; i <= 5; i++) log.append(transcript(i));
    expect(log.replay('s1', 0).map((p) => p.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(log.replay('s1', 3).map((p) => p.seq)).toEqual([4, 5]);
  });

  it('persists every push as one JSON line and the meta beside it', () => {
    log.open(META);
    log.append(transcript(1));
    log.append({ type: 'session.state', sessionId: 's1', sessionStatus: 'started', mode: 'rich', agent: 'claude' });
    const lines = readFileSync(join(root, 's1.events.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ type: 'session.state', seq: 2 });
    expect(JSON.parse(readFileSync(join(root, 's1.meta.json'), 'utf8'))).toMatchObject({ sessionId: 's1', projectId: 'p1' });
  });

  it('continues the sequence after a restart', () => {
    log.open(META);
    for (let i = 1; i <= 4; i++) log.append(transcript(i));

    // A fresh log over the same directory is what a daemon restart looks like.
    const reopened = createSessionLog({ root, ringSize: 3 });
    const meta = reopened.open({ sessionId: 's1' });
    expect(meta).toMatchObject({ projectId: 'p1', configDir: META.configDir });
    expect(reopened.lastSeq('s1')).toBe(4);
    expect(reopened.append(transcript(5)).seq).toBe(5);
    expect(reopened.replay('s1', 3).map((p) => p.seq)).toEqual([4, 5]);
  });

  it('lists persisted sessions without opening them', () => {
    log.open(META);
    log.open({ ...META, sessionId: 's2' });
    const fresh = createSessionLog({ root });
    expect(fresh.list().map((m) => m.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('pages history backwards from the newest, past the ring, reporting hasMore', () => {
    log.open(META);
    for (let i = 1; i <= 7; i++) log.append(transcript(i));

    const page1 = log.history('s1', { limit: 3 });
    expect(page1.events.map((p) => p.seq)).toEqual([5, 6, 7]);
    expect(page1.hasMore).toBe(true);

    const page2 = log.history('s1', { beforeSeq: 5, limit: 3 });
    expect(page2.events.map((p) => p.seq)).toEqual([2, 3, 4]);
    expect(page2.hasMore).toBe(true);

    const page3 = log.history('s1', { beforeSeq: 2, limit: 3 });
    expect(page3.events.map((p) => p.seq)).toEqual([1]);
    expect(page3.hasMore).toBe(false);
  });

  it('updates meta in place and stamps updatedAt', () => {
    log.open(META);
    log.updateMeta('s1', { title: 'renamed' });
    const meta = log.meta('s1');
    expect(meta?.title).toBe('renamed');
    expect(meta?.updatedAt).not.toBe(META.updatedAt);
    expect(JSON.parse(readFileSync(join(root, 's1.meta.json'), 'utf8')).title).toBe('renamed');
  });

  it('removes a session\'s files', () => {
    log.open(META);
    log.append(transcript(1));
    log.remove('s1');
    expect(existsSync(join(root, 's1.events.jsonl'))).toBe(false);
    expect(existsSync(join(root, 's1.meta.json'))).toBe(false);
    expect(log.meta('s1')).toBeNull();
  });

  it('skips a corrupt line on disk rather than failing the whole replay', () => {
    log.open(META);
    log.append(transcript(1));
    log.append(transcript(2));
    const file = join(root, 's1.events.jsonl');
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(file, '{not json\n');
    log.append(transcript(3));
    const reopened = createSessionLog({ root, ringSize: 1 });
    reopened.open({ sessionId: 's1' });
    expect(reopened.replay('s1', 0).map((p) => p.seq)).toEqual([1, 2, 3]);
  });
});

describe('remote session log — lastSeq is O(1), not O(file)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omnifex-session-log-tail-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seed(n: number, ringSize = 3): void {
    const log = createSessionLog({ root, ringSize });
    log.open(META);
    for (let i = 0; i < n; i += 1) log.append(transcript(i));
  }

  it('reads the last seq of a closed session without loading the whole file', () => {
    // The regression this pins: `lastSeq` fell through to a whole-file read +
    // JSON.parse per line for any session not currently open. `summaryOf`
    // calls it for EVERY known session and `/healthz` calls that on every
    // request — so one health probe read every byte of every session log.
    // With a 200MB spool and a once-per-second poll, the daemon's only thread
    // saturates and it stops answering at all.
    seed(500);
    const reopened = createSessionLog({ root, ringSize: 3 });
    expect(reopened.lastSeq('s1')).toBe(500);
  });

  it('is correct when the file is smaller than the tail window', () => {
    seed(2);
    expect(createSessionLog({ root, ringSize: 3 }).lastSeq('s1')).toBe(2);
  });

  it('is correct when a single record is larger than the tail window', () => {
    const log = createSessionLog({ root, ringSize: 3 });
    log.open(META);
    log.append(transcript(1));
    // A 256KB payload — comfortably past any fixed tail read.
    log.append({ ...transcript(2), payload: { blob: 'x'.repeat(256 * 1024) } } as never);
    expect(createSessionLog({ root, ringSize: 3 }).lastSeq('s1')).toBe(2);
  });

  it('ignores a torn trailing line, as readAll does', () => {
    seed(3);
    // Simulate the daemon being killed mid-append.
    appendFileSync(join(root, 's1.events.jsonl'), '{"type":"event","se', 'utf8');
    expect(createSessionLog({ root, ringSize: 3 }).lastSeq('s1')).toBe(3);
  });

  it('returns 0 for a session with no file at all', () => {
    expect(createSessionLog({ root, ringSize: 3 }).lastSeq('nope')).toBe(0);
  });

  it('returns 0 for an empty file', () => {
    writeFileSync(join(root, 's1.events.jsonl'), '', 'utf8');
    expect(createSessionLog({ root, ringSize: 3 }).lastSeq('s1')).toBe(0);
  });

  it('still prefers the in-memory seq for an open session', () => {
    const log = createSessionLog({ root, ringSize: 3 });
    log.open(META);
    log.append(transcript(1));
    expect(log.lastSeq('s1')).toBe(1);
  });

  it('answers repeatedly on a 40MB log well inside the poll interval', () => {
    // Sized to the real spool that wedged the daemon: a single session log
    // of tens of MB, asked for its lastSeq once per second per session.
    // Whole-file read + per-line JSON.parse is ~seconds per call here, so
    // the margin between the two implementations is three orders of
    // magnitude — this is a complexity assertion, not a micro-benchmark.
    const filler = 'x'.repeat(400);
    const lines: string[] = [];
    for (let i = 1; i <= 100_000; i += 1) {
      lines.push(JSON.stringify({ type: 'event', sessionId: 's1', kind: 'transcript', seq: i, payload: { filler } }));
    }
    writeFileSync(join(root, 's1.events.jsonl'), `${lines.join('\n')}\n`, 'utf8');
    expect(statSync(join(root, 's1.events.jsonl')).size).toBeGreaterThan(40 * 1024 * 1024);

    const reopened = createSessionLog({ root, ringSize: 3 });
    const started = Date.now();
    for (let i = 0; i < 50; i += 1) expect(reopened.lastSeq('s1')).toBe(100_000);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
