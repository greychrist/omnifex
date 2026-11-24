import fs from 'node:fs';
import path from 'node:path';
import { isRequestReplayLine } from './util/request-replay';
import type { Database } from './database';

/** What a session row needs from its transcript. */
export interface SessionMetadata {
  aiTitle?: string;
  customTitle?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
}

export interface SessionMetadataEntry extends SessionMetadata {
  size: number;
  mtimeMs: number;
  /** Byte offset just past the last complete line parsed. */
  offset: number;
}

/**
 * Where entries outlive the process. The in-memory map stays the fast path;
 * the store is consulted for a file the map has not seen (first look after a
 * restart) and written whenever a file is re-read.
 */
export interface SessionMetadataStore {
  load(filePath: string): SessionMetadataEntry | null;
  save(filePath: string, entry: SessionMetadataEntry): void;
  /** Drop rows for files directly in `dir` that are not in `present`. */
  prune(dir: string, present: Set<string>): void;
}

export interface SessionMetadataCache {
  /**
   * The transcript's metadata, reading only what changed since the last call.
   * Reads go through the thread pool, so a cold project does not stall the
   * daemon; overlapping calls for one file share a read.
   */
  get(filePath: string, stat: fs.Stats): Promise<SessionMetadata>;
  /** Drop entries for files in `dir` that are no longer in `present`. */
  prune(dir: string, present: Set<string>): void;
  size(): number;
  /** Total transcript bytes read so far — what the tests measure. */
  bytesRead(): number;
}

/**
 * The sessions page used to read and parse every transcript of a project in
 * full on every visit — 500 MB and ~1 s for a busy project, synchronously, so
 * the whole daemon stalled with it. The four values it wants are all
 * first-seen or last-wins, which makes a transcript's metadata a fold over its
 * lines: keep the fold and where it stopped, and an unchanged file (same size
 * and modified time) costs nothing, a grown one costs only its new lines.
 * Anything else — smaller, or same size with a new mtime — is read again from
 * the start.
 */
export function createSessionMetadataCache(store?: SessionMetadataStore): SessionMetadataCache {
  const entries = new Map<string, SessionMetadataEntry>();
  let totalRead = 0;

  function fold(entry: SessionMetadataEntry, text: string): void {
    for (const raw of text.split('\n')) {
      const trimmed = raw.trim();
      if (!trimmed || isRequestReplayLine(trimmed)) continue;
      let obj: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null) continue;
        obj = parsed as Record<string, unknown>;
      } catch {
        continue; // malformed, or a line still being written
      }
      // Every entry carrying a timestamp brackets the session's activity.
      const ts = obj.timestamp;
      if (typeof ts === 'string') {
        if (!entry.firstTimestamp) entry.firstTimestamp = ts;
        entry.lastTimestamp = ts;
      }
      // The CLI rewrites its generated title every turn; last one wins.
      if (obj.type === 'ai-title') {
        const title = obj.aiTitle;
        if (typeof title === 'string' && title.trim()) entry.aiTitle = title.trim();
        continue;
      }
      // A rename. Kept separate from the generated title: the CLI goes on
      // rewriting `ai-title` after a rename, so the two are resolved by
      // precedence (pickSessionTitle), never by which record came last.
      if (obj.type === 'custom-title') {
        const title = obj.customTitle;
        if (typeof title === 'string' && title.trim()) entry.customTitle = title.trim();
      }
    }
  }

  async function readFrom(filePath: string, start: number, end: number): Promise<Buffer> {
    const length = Math.max(0, end - start);
    const buf = Buffer.alloc(length);
    if (length === 0) return buf;
    const handle = await fs.promises.open(filePath, 'r');
    try {
      let read = 0;
      while (read < length) {
        const { bytesRead: n } = await handle.read(buf, read, length - read, start + read);
        if (n === 0) break;
        read += n;
      }
      totalRead += read;
      return read === length ? buf : buf.subarray(0, read);
    } finally {
      await handle.close();
    }
  }

  function snapshot(e: SessionMetadataEntry): SessionMetadata {
    const out: SessionMetadata = {};
    if (e.aiTitle !== undefined) out.aiTitle = e.aiTitle;
    if (e.customTitle !== undefined) out.customTitle = e.customTitle;
    if (e.firstTimestamp !== undefined) out.firstTimestamp = e.firstTimestamp;
    if (e.lastTimestamp !== undefined) out.lastTimestamp = e.lastTimestamp;
    return out;
  }

  const inflight = new Map<string, Promise<SessionMetadata>>();

  /** Memory first; the store answers for a file this process has not seen. */
  function lookup(filePath: string): SessionMetadataEntry | undefined {
    const inMemory = entries.get(filePath);
    if (inMemory || !store) return inMemory;
    let stored: SessionMetadataEntry | null = null;
    try {
      stored = store.load(filePath);
    } catch {
      // The store is an optimisation; a failed read means "read the file".
    }
    if (stored) entries.set(filePath, stored);
    return stored ?? undefined;
  }

  async function refresh(filePath: string, stat: fs.Stats): Promise<SessionMetadata> {
    const seen = lookup(filePath);
    if (seen && seen.size === stat.size && seen.mtimeMs === stat.mtimeMs) return snapshot(seen);

    const appended = seen !== undefined && stat.size > seen.size;
    const entry: SessionMetadataEntry = appended ? { ...seen } : { size: 0, mtimeMs: 0, offset: 0 };
    try {
      const chunk = await readFrom(filePath, entry.offset, stat.size);
      // Parse through the trailing partial line too (a file with no final
      // newline is still complete), but resume next time from the last
      // newline so a half-written line is read again whole. Re-folding a
      // line is harmless: every field is first-seen or last-wins.
      fold(entry, chunk.toString('utf8'));
      const lastNewline = chunk.lastIndexOf(0x0a);
      entry.offset += lastNewline + 1;
    } catch {
      // Unreadable now: report what we had, and try again next time.
      return seen ? snapshot(seen) : {};
    }
    entry.size = stat.size;
    entry.mtimeMs = stat.mtimeMs;
    entries.set(filePath, entry);
    try {
      store?.save(filePath, entry);
    } catch {
      // Kept in memory regardless; persisted again on its next re-read.
    }
    return snapshot(entry);
  }

  return {
    async get(filePath, stat) {
      // A read already under way for this file: wait for it, then check again
      // against this caller's stat (it may have seen a later size).
      for (let running = inflight.get(filePath); running; running = inflight.get(filePath)) {
        await running.catch(() => undefined);
      }
      const seen = lookup(filePath);
      if (seen && seen.size === stat.size && seen.mtimeMs === stat.mtimeMs) return snapshot(seen);
      const run = refresh(filePath, stat).finally(() => {
        inflight.delete(filePath);
      });
      inflight.set(filePath, run);
      return run;
    },

    prune(dir, present) {
      for (const key of entries.keys()) {
        if (path.dirname(key) === dir && !present.has(key)) entries.delete(key);
      }
      try {
        store?.prune(dir, present);
      } catch {
        // A stale row costs nothing: its file is never listed again.
      }
    },

    size: () => entries.size,
    bytesRead: () => totalRead,
  };
}

/** The SQLite store (`session_metadata_cache`, migration 34). */
export function createSqliteSessionMetadataStore(db: Database): SessionMetadataStore {
  const raw = db.raw;
  const selectOne = raw.prepare(
    'SELECT size, mtime_ms, read_offset, ai_title, custom_title, first_timestamp, last_timestamp FROM session_metadata_cache WHERE file_path = ?',
  );
  const upsert = raw.prepare(`
    INSERT INTO session_metadata_cache (file_path, size, mtime_ms, read_offset, ai_title, custom_title, first_timestamp, last_timestamp)
    VALUES (@file_path, @size, @mtime_ms, @read_offset, @ai_title, @custom_title, @first_timestamp, @last_timestamp)
    ON CONFLICT(file_path) DO UPDATE SET
      size = excluded.size, mtime_ms = excluded.mtime_ms, read_offset = excluded.read_offset,
      ai_title = excluded.ai_title, custom_title = excluded.custom_title,
      first_timestamp = excluded.first_timestamp, last_timestamp = excluded.last_timestamp
  `);
  // Prefix match by substr, not LIKE: `_` and `%` are legal in folder names.
  const selectUnder = raw.prepare(
    'SELECT file_path FROM session_metadata_cache WHERE substr(file_path, 1, length(@prefix)) = @prefix',
  );
  const deleteOne = raw.prepare('DELETE FROM session_metadata_cache WHERE file_path = ?');

  interface Row {
    size: number;
    mtime_ms: number;
    read_offset: number;
    ai_title: string | null;
    custom_title: string | null;
    first_timestamp: string | null;
    last_timestamp: string | null;
  }

  return {
    load(filePath) {
      const row = selectOne.get(filePath) as Row | undefined;
      if (!row) return null;
      const entry: SessionMetadataEntry = { size: row.size, mtimeMs: row.mtime_ms, offset: row.read_offset };
      if (row.ai_title !== null) entry.aiTitle = row.ai_title;
      if (row.custom_title !== null) entry.customTitle = row.custom_title;
      if (row.first_timestamp !== null) entry.firstTimestamp = row.first_timestamp;
      if (row.last_timestamp !== null) entry.lastTimestamp = row.last_timestamp;
      return entry;
    },
    save(filePath, e) {
      upsert.run({
        file_path: filePath,
        size: e.size,
        mtime_ms: e.mtimeMs,
        read_offset: e.offset,
        ai_title: e.aiTitle ?? null,
        custom_title: e.customTitle ?? null,
        first_timestamp: e.firstTimestamp ?? null,
        last_timestamp: e.lastTimestamp ?? null,
      });
    },
    prune(dir, present) {
      const rows = selectUnder.all({ prefix: dir + path.sep }) as { file_path: string }[];
      const stale = rows.map((r) => r.file_path).filter((p) => path.dirname(p) === dir && !present.has(p));
      if (stale.length === 0) return;
      raw.transaction(() => {
        for (const p of stale) deleteOne.run(p);
      })();
    },
  };
}
