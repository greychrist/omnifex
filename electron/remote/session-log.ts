/**
 * Per-session sequenced event log for the OmniFex Remote daemon.
 *
 * Owns the one thing the protocol promises about a session's pushes: `seq`
 * is monotonic per session, starts at 1, and covers `session.state`, `event`
 * and `permission.request` together — a `session.subscribe { fromSeq }`
 * replay restores a status change and a still-open permission prompt, not
 * just the transcript rows between them.
 *
 * Two tiers:
 *  - a ring buffer (default 5,000) for the common reconnect — the iPad was
 *    backgrounded for a minute and needs the tail;
 *  - an append-only JSONL file per session under `~/.omnifex/sessions/` for
 *    anything older, for `history.get`, and for surviving a daemon restart.
 *
 * Why not the CLI's own transcript under `<configDir>/projects/`? It has no
 * seq, it lacks everything the daemon synthesises (status transitions,
 * permission prompts, stderr), and its shapes differ from the stream-json the
 * renderer was built against (`isMeta` vs `isSynthetic`, top-level `effort`).
 * The daemon's log is the replay source; the CLI's file stays the CLI's.
 *
 * All I/O is synchronous. Appends are one small line each, and the caller is
 * the session bridge on the engine's message path, where an `await` would
 * reorder pushes against each other.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { SessionScopedPush, SessionScopedPushType } from '../../src/protocol';

export interface SessionMeta {
  sessionId: string;
  projectId: string;
  projectPath: string;
  configDir: string;
  agent: 'claude' | 'codex';
  mode: 'rich' | 'tui';
  title?: string;
  /** The `session.create` options, kept so a resume can respawn the same way. */
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * A push before the log has stamped it.
 *
 * Deliberately the loose shape rather than `Omit<SessionScopedPush, 'seq'>`:
 * the protocol schemas are zod loose objects, whose inferred type carries an
 * index signature, and `Omit` over an index signature collapses every known
 * key into `unknown`. The wire shape is still enforced — by
 * `ServerMessageSchema` in the transport, and by the bridge fixture test.
 */
export interface UnsequencedPush {
  type: SessionScopedPushType;
  sessionId: string;
  [key: string]: unknown;
}

export interface HistoryPage {
  events: SessionScopedPush[];
  hasMore: boolean;
}

export interface SessionLog {
  /**
   * Bring a session into memory. With full meta this is a create; with only
   * `{ sessionId }` it loads what is on disk (a resume after restart) and
   * throws if nothing is there. Idempotent for an already-open session.
   */
  open(meta: SessionMeta | { sessionId: string }): SessionMeta;
  /** Stamp `seq`, keep in the ring, append to disk. Throws if not open. */
  append(push: UnsequencedPush): SessionScopedPush;
  lastSeq(sessionId: string): number;
  /** Every push with `seq > fromSeq`, oldest first. */
  replay(sessionId: string, fromSeq: number): SessionScopedPush[];
  /** Newest-first paging for a transcript read from the bottom; returned oldest-first. */
  history(sessionId: string, opts: { beforeSeq?: number; limit: number }): HistoryPage;
  meta(sessionId: string): SessionMeta | null;
  updateMeta(sessionId: string, patch: Partial<Omit<SessionMeta, 'sessionId'>>): SessionMeta;
  /** Every session with a meta file on disk, open or not. */
  list(): SessionMeta[];
  /** Delete the session's files and forget it. */
  remove(sessionId: string): void;
  isOpen(sessionId: string): boolean;
}

interface OpenSession {
  meta: SessionMeta;
  seq: number;
  ring: SessionScopedPush[];
}

const DEFAULT_RING_SIZE = 5_000;

export function createSessionLog(opts: { root: string; ringSize?: number }): SessionLog {
  const ringSize = Math.max(1, opts.ringSize ?? DEFAULT_RING_SIZE);
  const open = new Map<string, OpenSession>();

  const eventsPath = (id: string) => join(opts.root, `${id}.events.jsonl`);
  const metaPath = (id: string) => join(opts.root, `${id}.meta.json`);

  function readMeta(id: string): SessionMeta | null {
    try {
      return JSON.parse(readFileSync(metaPath(id), 'utf8')) as SessionMeta;
    } catch {
      return null;
    }
  }

  function writeMeta(meta: SessionMeta): void {
    mkdirSync(opts.root, { recursive: true });
    writeFileSync(metaPath(meta.sessionId), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  }

  /**
   * Whole-file read. A session's log is a few MB at the very most, and this
   * runs only for a replay that outran the ring or for a history page — never
   * on the hot append path.
   */
  function readAll(id: string): SessionScopedPush[] {
    let text: string;
    try {
      text = readFileSync(eventsPath(id), 'utf8');
    } catch {
      return [];
    }
    const out: SessionScopedPush[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as SessionScopedPush);
      } catch {
        // A torn write (daemon killed mid-append) costs one line, not the
        // session. Skip it; seq continuity is re-derived from what parses.
      }
    }
    return out;
  }

  function require(id: string): OpenSession {
    const s = open.get(id);
    if (!s) throw new Error(`session log: ${id} is not open`);
    return s;
  }

  return {
    open(input) {
      const existing = open.get(input.sessionId);
      if (existing) return existing.meta;

      const fromDisk = readMeta(input.sessionId);
      let meta: SessionMeta;
      if ('projectId' in input) {
        meta = fromDisk ? { ...fromDisk, ...input } : input;
        writeMeta(meta);
      } else {
        if (!fromDisk) throw new Error(`session log: no persisted session ${input.sessionId}`);
        meta = fromDisk;
      }

      // Seq continues from whatever survived on disk, so a resumed client's
      // `fromSeq` still means what it meant before the restart.
      const persisted = readAll(meta.sessionId);
      const seq = persisted.length ? persisted[persisted.length - 1].seq : 0;
      open.set(meta.sessionId, { meta, seq, ring: persisted.slice(-ringSize) });
      return meta;
    },

    append(push) {
      const s = require(push.sessionId);
      s.seq += 1;
      const stamped = { ...push, seq: s.seq } as SessionScopedPush;
      s.ring.push(stamped);
      if (s.ring.length > ringSize) s.ring.splice(0, s.ring.length - ringSize);
      mkdirSync(opts.root, { recursive: true });
      appendFileSync(eventsPath(push.sessionId), `${JSON.stringify(stamped)}\n`, 'utf8');
      return stamped;
    },

    lastSeq(id) {
      return open.get(id)?.seq ?? (readAll(id).at(-1)?.seq ?? 0);
    },

    replay(id, fromSeq) {
      const s = open.get(id);
      const ring = s?.ring ?? [];
      const oldestInRing = ring[0]?.seq ?? Number.POSITIVE_INFINITY;
      // The ring is authoritative when it reaches back far enough; otherwise
      // the file has everything the ring evicted.
      const source = fromSeq + 1 >= oldestInRing ? ring : readAll(id);
      return source.filter((p) => p.seq > fromSeq);
    },

    history(id, { beforeSeq, limit }) {
      const all = readAll(id);
      const upper = beforeSeq ?? Number.POSITIVE_INFINITY;
      const older = all.filter((p) => p.seq < upper);
      const events = older.slice(Math.max(0, older.length - limit));
      return { events, hasMore: older.length > events.length };
    },

    meta(id) {
      return open.get(id)?.meta ?? readMeta(id);
    },

    updateMeta(id, patch) {
      const s = open.get(id);
      const current = s?.meta ?? readMeta(id);
      if (!current) throw new Error(`session log: no session ${id}`);
      const next: SessionMeta = { ...current, ...patch, sessionId: id, updatedAt: new Date().toISOString() };
      if (s) s.meta = next;
      writeMeta(next);
      return next;
    },

    list() {
      let names: string[];
      try {
        names = readdirSync(opts.root);
      } catch {
        return [];
      }
      const out: SessionMeta[] = [];
      for (const name of names) {
        if (!name.endsWith('.meta.json')) continue;
        const meta = readMeta(name.slice(0, -'.meta.json'.length));
        if (meta) out.push(meta);
      }
      return out;
    },

    remove(id) {
      open.delete(id);
      rmSync(eventsPath(id), { force: true });
      rmSync(metaPath(id), { force: true });
    },

    isOpen(id) {
      return open.has(id) || existsSync(metaPath(id));
    },
  };
}
