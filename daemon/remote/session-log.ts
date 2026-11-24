// `seq` is per session and covers state, event and permission pushes, so a replay restores an open prompt.
// Events live only in the ring; the CLI's transcript is the history. Only `<id>.meta.json` is persisted.
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
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Loose on purpose: `Omit` over the zod loose schemas' index signature collapses every key to `unknown`. */
export interface UnsequencedPush {
  type: SessionScopedPushType;
  sessionId: string;
  [key: string]: unknown;
}

export interface SessionLog {
  open(meta: SessionMeta | { sessionId: string }): SessionMeta;
  append(push: UnsequencedPush): SessionScopedPush;
  lastSeq(sessionId: string): number;
  /** Null when the ring cannot answer; the client must then reload from the CLI's JSONL. */
  replay(sessionId: string, fromSeq: number): SessionScopedPush[] | null;
  meta(sessionId: string): SessionMeta | null;
  updateMeta(sessionId: string, patch: Partial<Omit<SessionMeta, 'sessionId'>>): SessionMeta;
  updateOptions(sessionId: string, patch: Record<string, unknown>): void;
  list(): SessionMeta[];
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
  /** Cached: /healthz and the permission poll list constantly, and re-reading 400+ files blocked the event loop. */
  let index: Map<string, SessionMeta> | null = null;

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
    index?.set(meta.sessionId, meta);
  }

  function buildIndex(): Map<string, SessionMeta> {
    const built = new Map<string, SessionMeta>();
    let names: string[];
    try {
      names = readdirSync(opts.root);
    } catch {
      return built;
    }
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      const id = name.slice(0, -'.meta.json'.length);
      const meta = readMeta(id);
      if (meta) built.set(id, meta);
    }
    return built;
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
      return open.get(id)?.meta ?? index?.get(id) ?? readMeta(id);
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

    updateOptions(id, patch) {
      const current = open.get(id)?.meta ?? readMeta(id);
      if (!current) return;
      const next: SessionMeta = { ...current, options: { ...current.options, ...patch }, updatedAt: new Date().toISOString() };
      const s = open.get(id);
      if (s) s.meta = next;
      writeMeta(next);
    },

    list() {
      index ??= buildIndex();
      return [...index.values()];
    },

    remove(id) {
      open.delete(id);
      index?.delete(id);
      rmSync(metaPath(id), { force: true });
    },

    isOpen(id) {
      return open.has(id) || existsSync(metaPath(id));
    },
  };
}
