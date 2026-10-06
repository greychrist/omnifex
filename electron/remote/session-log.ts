/**
 * Per-session sequenced event log for the OmniFex Remote daemon.
 *
 * Owns the one thing the protocol promises about a session's pushes: `seq`
 * is monotonic per session, starts at 1, and covers `session.state`, `event`
 * and `permission.request` together — a `session.subscribe { fromSeq }`
 * replay restores a status change and a still-open permission prompt, not
 * just the transcript rows between them.
 *
 * The events live in a ring buffer (default 5,000) and nowhere else. It
 * serves the common reconnect — the iPad was backgrounded for a minute and
 * needs the tail. Anything the ring cannot answer (a reconnect that fell
 * further behind, a seq from before a daemon restart) is a gap, and a gap is
 * answered by the client reloading the transcript from the CLI's own JSONL,
 * which is what it does on every page load anyway.
 *
 * Events used to be appended to `<id>.events.jsonl` as well. Nothing read
 * that file except a replay past the ring and `history.get`, which no client
 * called; it grew to 1.1GB in its first 26 days, 62% of it streaming text
 * deltas the finished message supersedes. The CLI's transcript is the
 * history. Only `<id>.meta.json` is persisted: what a resume needs to
 * respawn the session.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SessionScopedPush, SessionScopedPushType } from '../../src/protocol';

export interface SessionMeta {
  sessionId: string;
  projectId: string;
  projectPath: string;
  configDir: string;
  agent: 'claude' | 'codex';
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

export interface SessionLog {
  /**
   * Bring a session into memory. With full meta this is a create; with only
   * `{ sessionId }` it loads the meta on disk (a resume after restart) and
   * throws if there is none. Idempotent for an already-open session. The
   * sequence starts at 1 on every daemon run.
   */
  open(meta: SessionMeta | { sessionId: string }): SessionMeta;
  /** Stamp `seq` and keep it in the ring. Throws if not open. */
  append(push: UnsequencedPush): SessionScopedPush;
  lastSeq(sessionId: string): number;
  /**
   * Every push with `seq > fromSeq`, oldest first — or null when the ring
   * cannot answer: `fromSeq` is older than the oldest push it still holds, or
   * newer than the last one (a seq from before a daemon restart). Null means
   * the client must reload the transcript from the CLI's JSONL.
   */
  replay(sessionId: string, fromSeq: number): SessionScopedPush[] | null;
  meta(sessionId: string): SessionMeta | null;
  updateMeta(sessionId: string, patch: Partial<Omit<SessionMeta, 'sessionId'>>): SessionMeta;
  /** Every session with a meta file on disk, open or not. */
  list(): SessionMeta[];
  /** Delete the session's meta and forget it. */
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

      open.set(meta.sessionId, { meta, seq: 0, ring: [] });
      return meta;
    },

    append(push) {
      const s = require(push.sessionId);
      s.seq += 1;
      const stamped = { ...push, seq: s.seq } as SessionScopedPush;
      s.ring.push(stamped);
      if (s.ring.length > ringSize) s.ring.splice(0, s.ring.length - ringSize);
      return stamped;
    },

    lastSeq(id) {
      return open.get(id)?.seq ?? 0;
    },

    replay(id, fromSeq) {
      const s = open.get(id);
      const seq = s?.seq ?? 0;
      if (fromSeq > seq) return null;
      const ring = s?.ring ?? [];
      const oldestInRing = ring[0]?.seq ?? seq + 1;
      if (fromSeq + 1 < oldestInRing) return null;
      return ring.filter((p) => p.seq > fromSeq);
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
      rmSync(metaPath(id), { force: true });
    },

    isOpen(id) {
      return open.has(id) || existsSync(metaPath(id));
    },
  };
}
