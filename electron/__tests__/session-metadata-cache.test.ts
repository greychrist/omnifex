import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionMetadataCache, createSqliteSessionMetadataStore } from '../services/session-metadata-cache';
import { createDatabase, type Database } from '../services/database';

const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

describe('session metadata cache', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-cache-'));
    file = path.join(dir, 's.jsonl');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const read = (cache: ReturnType<typeof createSessionMetadataCache>) => cache.get(file, fs.statSync(file));

  it('pulls the titles and first/last timestamps out of a transcript', async () => {
    fs.writeFileSync(file,
      line({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z' })
      + line({ type: 'ai-title', aiTitle: ' Generated ' })
      + line({ type: 'custom-title', customTitle: 'Renamed' })
      + line({ type: 'assistant', timestamp: '2026-01-02T00:00:00.000Z' }));
    expect(await read(createSessionMetadataCache())).toEqual({
      aiTitle: 'Generated', customTitle: 'Renamed',
      firstTimestamp: '2026-01-01T00:00:00.000Z', lastTimestamp: '2026-01-02T00:00:00.000Z',
    });
  });

  // The point of the cache: a transcript nobody wrote to since the last look
  // is not read again.
  it('does not read a file that has not changed since it was last read', async () => {
    fs.writeFileSync(file, line({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }));
    const cache = createSessionMetadataCache();
    await read(cache);
    const before = cache.bytesRead();
    expect((await read(cache)).firstTimestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(cache.bytesRead()).toBe(before);
  });

  // Transcripts are append-only: a grown file costs only its new lines.
  it('reads only the appended bytes of a file that grew', async () => {
    const first = line({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }) + line({ type: 'ai-title', aiTitle: 'Old' });
    fs.writeFileSync(file, first);
    const cache = createSessionMetadataCache();
    await read(cache);
    const before = cache.bytesRead();
    const added = line({ type: 'ai-title', aiTitle: 'New' }) + line({ type: 'assistant', timestamp: '2026-01-03T00:00:00.000Z' });
    fs.appendFileSync(file, added);
    expect(await read(cache)).toMatchObject({
      aiTitle: 'New', firstTimestamp: '2026-01-01T00:00:00.000Z', lastTimestamp: '2026-01-03T00:00:00.000Z',
    });
    expect(cache.bytesRead() - before).toBe(Buffer.byteLength(added));
  });

  // A line caught half-written is read again once it is complete.
  it('picks up a line that was half-written at the last read', async () => {
    const whole = line({ type: 'custom-title', customTitle: 'Finished' });
    fs.writeFileSync(file, line({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }) + whole.slice(0, 10));
    const cache = createSessionMetadataCache();
    expect((await read(cache)).customTitle).toBeUndefined();
    fs.appendFileSync(file, whole.slice(10));
    expect((await read(cache)).customTitle).toBe('Finished');
  });

  it('reads a file again from the start when it was rewritten, not appended to', async () => {
    fs.writeFileSync(file, line({ type: 'ai-title', aiTitle: 'A long original title here' }));
    const cache = createSessionMetadataCache();
    await read(cache);
    fs.writeFileSync(file, line({ type: 'ai-title', aiTitle: 'Short' }));
    expect((await read(cache)).aiTitle).toBe('Short');
  });

  it('notices a same-size rewrite by its modified time', async () => {
    fs.writeFileSync(file, line({ type: 'ai-title', aiTitle: 'AAAA' }));
    const cache = createSessionMetadataCache();
    await read(cache);
    fs.writeFileSync(file, line({ type: 'ai-title', aiTitle: 'BBBB' }));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    expect((await read(cache)).aiTitle).toBe('BBBB');
  });

  it('keeps a file with no trailing newline readable', async () => {
    fs.writeFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'No newline' }));
    expect((await read(createSessionMetadataCache())).customTitle).toBe('No newline');
  });

  it('forgets files gone from a folder, and only from that folder', async () => {
    fs.writeFileSync(file, line({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }));
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-cache-other-'));
    const other = path.join(otherDir, 'o.jsonl');
    fs.writeFileSync(other, line({ type: 'user' }));
    const cache = createSessionMetadataCache();
    await read(cache);
    await cache.get(other, fs.statSync(other));
    expect(cache.size()).toBe(2);
    cache.prune(dir, new Set());
    expect(cache.size()).toBe(1);
    fs.rmSync(otherDir, { recursive: true, force: true });
  });
});

describe('session metadata cache — concurrency', () => {
  // Two visits racing on one file share a single read rather than both
  // reading it and folding the same bytes twice.
  it('shares one read between overlapping requests for the same file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-cache-race-'));
    const file = path.join(dir, 's.jsonl');
    const body = line({ type: 'ai-title', aiTitle: 'Once' });
    fs.writeFileSync(file, body);
    const cache = createSessionMetadataCache();
    const stat = fs.statSync(file);
    const [a, b] = await Promise.all([cache.get(file, stat), cache.get(file, stat)]);
    expect(a.aiTitle).toBe('Once');
    expect(b.aiTitle).toBe('Once');
    expect(cache.bytesRead()).toBe(Buffer.byteLength(body));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('session metadata cache — persisted', () => {
  // A daemon restart starts a new cache. With the SQLite store behind it, an
  // unchanged transcript is still not read, and a grown one costs only its
  // new lines.
  let dir: string;
  let file: string;
  let db: Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-cache-db-'));
    file = path.join(dir, 's.jsonl');
    db = createDatabase(':memory:');
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('survives a restart: an unchanged file is not read again', async () => {
    fs.writeFileSync(file, line({ type: 'ai-title', aiTitle: 'Kept' }) + line({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }));
    await createSessionMetadataCache(createSqliteSessionMetadataStore(db)).get(file, fs.statSync(file));
    const restarted = createSessionMetadataCache(createSqliteSessionMetadataStore(db));
    expect(await restarted.get(file, fs.statSync(file))).toEqual({
      aiTitle: 'Kept', firstTimestamp: '2026-01-01T00:00:00.000Z', lastTimestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(restarted.bytesRead()).toBe(0);
  });

  it('survives a restart: a grown file costs only its new lines', async () => {
    fs.writeFileSync(file, line({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }));
    await createSessionMetadataCache(createSqliteSessionMetadataStore(db)).get(file, fs.statSync(file));
    const added = line({ type: 'custom-title', customTitle: 'Later' });
    fs.appendFileSync(file, added);
    const restarted = createSessionMetadataCache(createSqliteSessionMetadataStore(db));
    expect(await restarted.get(file, fs.statSync(file))).toMatchObject({ customTitle: 'Later', firstTimestamp: '2026-01-01T00:00:00.000Z' });
    expect(restarted.bytesRead()).toBe(Buffer.byteLength(added));
  });

  it('drops pruned files from the store too', async () => {
    fs.writeFileSync(file, line({ type: 'user' }));
    const cache = createSessionMetadataCache(createSqliteSessionMetadataStore(db));
    await cache.get(file, fs.statSync(file));
    cache.prune(dir, new Set());
    const n = db.raw.prepare('SELECT COUNT(*) AS n FROM session_metadata_cache').get() as { n: number };
    expect(n.n).toBe(0);
  });
});
