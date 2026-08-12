import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createSourceStateStore, type SourceStateStore } from '../services/brain/sources/state';
import type { SourceItem } from '../services/brain/sources/types';

describe('brain source state', () => {
  let db: Database;
  let store: SourceStateStore;
  let dir: string;
  let accountId: number;

  function item(overrides: Partial<SourceItem> = {}): SourceItem {
    return {
      sourceId: 'session',
      itemKey: 'sess-1',
      accountId,
      path: join(dir, 'sess-1.jsonl'),
      mtimeMs: 1_000,
      size: 42,
      label: 'omnifex',
      ...overrides,
    };
  }

  function addAccount(name: string): number {
    const info = db.raw
      .prepare(
        `INSERT INTO accounts (name, config_dir, engine, subscription_label, has_cost)
         VALUES (?, ?, 'claude', 'Max', 0)`,
      )
      .run(name, join(dir, name));
    return Number(info.lastInsertRowid);
  }

  beforeEach(() => {
    db = createDatabase(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'brain-src-'));
    accountId = addAccount('personal');
    store = createSourceStateStore(db);
    writeFileSync(item().path, 'hello', 'utf-8');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats an item it has never seen as changed', () => {
    expect(store.hasChanged(item())).toBe(true);
  });

  it('treats an unmodified item as unchanged after recording it', () => {
    store.record(item(), { status: 'indexed' });
    expect(store.hasChanged(item())).toBe(false);
  });

  it('rehashes when mtime moves and reports unchanged if the bytes are identical', () => {
    store.record(item(), { status: 'indexed' });
    // A touch without an edit: mtime moved, content did not. The sha256 check
    // is what stops this from re-indexing an entire vault after a backup
    // restore or a checkout that rewrites timestamps.
    expect(store.hasChanged(item({ mtimeMs: 9_999 }))).toBe(false);
  });

  it('reports changed when the bytes differ', () => {
    store.record(item(), { status: 'indexed' });
    writeFileSync(item().path, 'hello world', 'utf-8');
    expect(store.hasChanged(item({ mtimeMs: 9_999, size: 11 }))).toBe(true);
  });

  it('scopes state by account: the same item key under another account is unseen', () => {
    const other = addAccount('work');
    store.record(item(), { status: 'indexed' });
    expect(store.hasChanged(item({ accountId: other }))).toBe(true);
  });

  it('round-trips status and error, and lists only one account at a time', () => {
    store.record(item(), { status: 'failed', error: 'zod: entities required' });
    const rows = store.list(accountId, 'session');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toBe('zod: entities required');
  });

  it('upserts rather than duplicating on re-record', () => {
    store.record(item(), { status: 'pending' });
    store.record(item(), { status: 'indexed' });
    const rows = store.list(accountId, 'session');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('indexed');
    // A successful record clears a stale error, or the Sources pane keeps
    // showing a failure that has since been fixed.
    expect(rows[0].error).toBeNull();
  });

  it('treats a vanished file as changed rather than throwing', () => {
    store.record(item(), { status: 'indexed' });
    rmSync(item().path);
    // Re-examining an item whose backing file disappeared is the correct
    // outcome; the caller decides what to do about it.
    expect(store.hasChanged(item({ mtimeMs: 9_999 }))).toBe(true);
  });
});
