import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionLog, type SessionLog, type SessionMeta } from '../remote/session-log';

const META: SessionMeta = {
  sessionId: 's1',
  projectId: 'p1',
  projectPath: '/Users/greg/Repos/omnifex',
  configDir: '/Users/greg/.claude-personal',
  agent: 'claude',
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
    expect(log.replay('s1', 1)?.map((p) => p.seq)).toEqual([2, 3]);
    expect(log.replay('s1', 3)).toEqual([]);
    expect(log.replay('s1', 0)?.map((p) => p.seq)).toEqual([1, 2, 3]);
  });

  it('reports a gap when fromSeq predates the ring', () => {
    // ringSize is 3, so seq 1 and 2 have been evicted by the time 5 lands.
    // Nothing on disk holds them any more: the client must reload the
    // transcript from the CLI's JSONL instead.
    log.open(META);
    for (let i = 1; i <= 5; i++) log.append(transcript(i));
    expect(log.replay('s1', 0)).toBeNull();
    expect(log.replay('s1', 1)).toBeNull();
    expect(log.replay('s1', 2)?.map((p) => p.seq)).toEqual([3, 4, 5]);
  });

  it('reports a gap when fromSeq is ahead of the log', () => {
    // A client still holding a seq from before a daemon restart.
    log.open(META);
    log.append(transcript(1));
    expect(log.replay('s1', 9)).toBeNull();
  });

  it('writes nothing to disk but the meta file', () => {
    log.open(META);
    log.append(transcript(1));
    log.append({ type: 'session.state', sessionId: 's1', sessionStatus: 'started', agent: 'claude' });
    expect(readdirSync(root)).toEqual(['s1.meta.json']);
    expect(JSON.parse(readFileSync(join(root, 's1.meta.json'), 'utf8'))).toMatchObject({ sessionId: 's1', projectId: 'p1' });
  });

  it('starts the sequence over after a restart, keeping the meta', () => {
    log.open(META);
    for (let i = 1; i <= 4; i++) log.append(transcript(i));

    // A fresh log over the same directory is what a daemon restart looks like.
    const reopened = createSessionLog({ root, ringSize: 3 });
    expect(reopened.lastSeq('s1')).toBe(0);
    const meta = reopened.open({ sessionId: 's1' });
    expect(meta).toMatchObject({ projectId: 'p1', configDir: META.configDir });
    expect(reopened.append(transcript(5)).seq).toBe(1);
  });

  it('lists persisted sessions without opening them', () => {
    log.open(META);
    log.open({ ...META, sessionId: 's2' });
    const fresh = createSessionLog({ root });
    expect(fresh.list().map((m) => m.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('updates meta in place and stamps updatedAt', () => {
    log.open(META);
    log.updateMeta('s1', { title: 'renamed' });
    const meta = log.meta('s1');
    expect(meta?.title).toBe('renamed');
    expect(meta?.updatedAt).not.toBe(META.updatedAt);
    expect(JSON.parse(readFileSync(join(root, 's1.meta.json'), 'utf8')).title).toBe('renamed');
  });

  it('removes a session\'s meta', () => {
    log.open(META);
    log.append(transcript(1));
    log.remove('s1');
    expect(existsSync(join(root, 's1.meta.json'))).toBe(false);
    expect(log.meta('s1')).toBeNull();
  });
});
