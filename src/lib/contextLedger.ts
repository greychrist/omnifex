// Session context ledger — what shaped this session, and when.
//
// The CLI emits what it ACTUALLY loaded, as `attachment` records. That is the
// whole reason this module reads the transcript instead of walking the disk:
// a disk walk guesses at what the CLI probably read, and is wrong in both
// directions. It misses `CLAUDE.local.md` (always loaded) and `AGENTS.md`
// (loaded as of CLI 2.1.277), and it reports files the session never picked
// up. Reading the attachment stream makes every one of those correct without
// naming a single filename here — when the CLI loads a file, it says so.
//
// See docs/superpowers/specs/2026-09-18-session-context-ledger-design.md.
//
// PURE AND IDEMPOTENT. No Date.now(), no IO, no module state; timestamps come
// from the records. Folding the same records twice yields a deep-equal ledger.
// That property is what makes this safe to memoise per session and cheap to
// test, and it is the property tested hardest.

import type { JsonlNode } from '@/types/jsonl';

export type ContextEntryKind =
  | 'instruction-file'
  | 'nested-memory'
  | 'mcp-server'
  | 'agent'
  | 'skills'
  | 'deferred-tool';

/** Scopes the CLI is known to emit. `AutoMem` is the auto-memory MEMORY.md.
 *  Deliberately open: an earlier closed allow-list of the first four silently
 *  dropped `AutoMem` the moment it was checked against real transcripts, and
 *  the CLI can add another any release. Unknown scopes pass through and the
 *  UI styles what it recognises. */
export type ContextScope =
  | 'User' | 'Project' | 'Local' | 'Managed' | 'AutoMem'
  | (string & {});

export interface LedgerEntry {
  /** Stable identity, `${kind}:${label}`. Not unique across re-adds — a name
   *  that goes out and comes back yields two entries sharing an id, which is
   *  correct: they are two arrivals of the same thing. */
  id: string;
  kind: ContextEntryKind;
  /** Path for files, server/agent/tool name otherwise. */
  label: string;
  scope?: ContextScope;
  content?: string;
  /** Arrival timestamp, taken from the record. */
  at: string;
  /** Still in effect at the end of the fold. */
  live: boolean;
  /** When it stopped being live. Absent while live. */
  endedAt?: string;
}

export interface ContextLedger {
  /** Arrival order. This is the audit; `live` is the overlay on it. */
  entries: LedgerEntry[];
  liveCount: number;
  /** False when the session predates the CLI emitting these records (before
   *  ~2026-09-08). The UI must say so rather than render an empty list — an
   *  empty list reads as "nothing influenced this session", which is false. */
  tracked: boolean;
}

/** Attachment sub-types this ledger folds. Everything else on the attachment
 *  channel is per-turn bookkeeping — `total_tokens_reminder` alone accounts
 *  for 20,969 records on disk. See the spec's noise-control section. */
const IN_SCOPE = new Set([
  'instructions',
  'nested_memory',
  'mcp_instructions_delta',
  'agent_listing_delta',
  'deferred_tools_delta',
  'skill_listing',
]);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

function scopeOf(v: unknown): ContextScope | undefined {
  return str(v);
}

/**
 * Fold a session's records into its context ledger.
 *
 * Three rules, one per emission semantic the CLI actually uses. They are not
 * interchangeable — applying the wrong one produces a plausible-looking wrong
 * answer, so they are enumerated rather than generalised:
 *
 *   snapshot  `instructions`, `skill_listing`      later supersedes earlier
 *   delta     `*_delta`                            added / removed / readded
 *   additive  `nested_memory`                      append once, stays live
 */
export function foldContextLedger(records: readonly JsonlNode[]): ContextLedger {
  const entries: LedgerEntry[] = [];
  let tracked = false;

  // Index of the currently-live entry per identity, so a `removed` can reach
  // back and close the arrival it belongs to. A re-add clears the slot and
  // pushes a fresh entry rather than reviving the old one — two arrivals is
  // the honest rendering of out-and-back.
  const liveIdx = new Map<string, number>();

  const open = (
    kind: ContextEntryKind,
    label: string,
    at: string,
    extra?: { scope?: ContextScope; content?: string },
  ) => {
    const id = `${kind}:${label}`;
    if (liveIdx.has(id)) return; // already live — not a new arrival
    const entry: LedgerEntry = { id, kind, label, at, live: true };
    if (extra?.scope !== undefined) entry.scope = extra.scope;
    if (extra?.content !== undefined) entry.content = extra.content;
    liveIdx.set(id, entries.length);
    entries.push(entry);
  };

  const close = (kind: ContextEntryKind, label: string, at: string) => {
    const id = `${kind}:${label}`;
    const idx = liveIdx.get(id);
    if (idx === undefined) return;
    entries[idx] = { ...entries[idx], live: false, endedAt: at };
    liveIdx.delete(id);
  };

  /** Close every live entry of a kind that the newest snapshot omits. */
  const retainOnly = (kind: ContextEntryKind, keep: Set<string>, at: string) => {
    for (const [id, idx] of [...liveIdx.entries()]) {
      const e = entries[idx];
      if (e.kind !== kind || keep.has(e.label)) continue;
      entries[idx] = { ...e, live: false, endedAt: at };
      liveIdx.delete(id);
    }
  };

  for (const rec of records) {
    if (rec.kind !== 'attachment') continue;
    const att = (rec as { raw?: { attachment?: Record<string, unknown> } }).raw?.attachment;
    const subtype = str(att?.type);
    if (!att || !subtype || !IN_SCOPE.has(subtype)) continue;

    const at = (rec as { receivedAt?: string }).receivedAt;
    if (typeof at !== 'string') continue;
    tracked = true;

    switch (subtype) {
      case 'instructions': {
        if (!Array.isArray(att.files)) break;
        const keep = new Set<string>();
        for (const f of att.files) {
          if (!f || typeof f !== 'object') continue;
          const file = f as Record<string, unknown>;
          const path = str(file.path);
          if (!path) continue;
          keep.add(path);
          open('instruction-file', path, at, {
            scope: scopeOf(file.type),
            content: str(file.content),
          });
        }
        // A file dropped from a later snapshot is no longer in context.
        retainOnly('instruction-file', keep, at);
        break;
      }

      case 'nested_memory': {
        // `path` sits at the top level AND inside `content`; the nested copy
        // also carries the scope. The CLI's loadedNestedMemoryPaths means a
        // repeat is a no-op, which `open` already gives us.
        const inner = (att.content && typeof att.content === 'object')
          ? (att.content as Record<string, unknown>)
          : {};
        const path = str(att.path) ?? str(inner.path);
        if (!path) break;
        open('nested-memory', path, at, {
          scope: scopeOf(inner.type),
          content: str(inner.content),
        });
        break;
      }

      case 'mcp_instructions_delta': {
        const added = strArray(att.addedNames);
        const blocks = strArray(att.addedBlocks);
        added.forEach((name, i) => {
          open('mcp-server', name, at, { content: blocks[i] });
        });
        for (const name of strArray(att.removedNames)) close('mcp-server', name, at);
        break;
      }

      case 'agent_listing_delta': {
        for (const name of strArray(att.addedTypes)) open('agent', name, at);
        for (const name of strArray(att.removedTypes)) close('agent', name, at);
        break;
      }

      case 'deferred_tools_delta': {
        for (const name of strArray(att.addedNames)) open('deferred-tool', name, at);
        for (const name of strArray(att.removedNames)) close('deferred-tool', name, at);
        // readdedNames is why liveness is a fold and not a set-difference:
        // a tool can go out and come back, and both transitions are events.
        for (const name of strArray(att.readdedNames)) open('deferred-tool', name, at);
        break;
      }

      case 'skill_listing': {
        const content = str(att.content);
        if (content === undefined) break;
        // One logical slot; each listing supersedes the last. Keyed by
        // content so an unchanged re-emission is not a new arrival.
        retainOnly('skills', new Set([content]), at);
        open('skills', content, at, { content });
        break;
      }
    }
  }

  return { entries, liveCount: liveIdx.size, tracked };
}

/**
 * One line describing what a context attachment did, for the inline marker in
 * the transcript — or null when the record is not one this ledger tracks.
 *
 * Null is the common case by a wide margin: `total_tokens_reminder` alone is
 * 20,969 records on disk against roughly ten in-scope ones per session. The
 * marker exists to give an arrival a place in the feed, not to narrate every
 * attachment envelope the CLI writes.
 *
 * Counts, never content. The panel is where content is reviewed; a transcript
 * row that inlined a 27,000-character CLAUDE.md would bury the conversation.
 */
export function summariseContextAttachment(
  attachment: Record<string, unknown> | undefined,
): string | null {
  const type = str(attachment?.type);
  if (!attachment || !type || !IN_SCOPE.has(type)) return null;

  /** `+2 −1`, omitting a side that did not move. U+2212 minus, not a hyphen. */
  const delta = (label: string, added: number, removed: number): string | null => {
    if (added === 0 && removed === 0) return null;
    const parts: string[] = [];
    if (added > 0) parts.push(`+${added}`);
    if (removed > 0) parts.push(`−${removed}`);
    return `${label} ${parts.join(' ')}`;
  };

  switch (type) {
    case 'instructions': {
      const n = Array.isArray(attachment.files) ? attachment.files.length : 0;
      if (n === 0) return null;
      return `Instructions loaded — ${n} file${n === 1 ? '' : 's'}`;
    }

    case 'nested_memory': {
      const path = str(attachment.path)
        ?? str((attachment.content as Record<string, unknown> | undefined)?.path);
      if (!path) return null;
      // Last two segments: a bare basename is almost always `CLAUDE.md`, which
      // identifies nothing when several are loaded.
      const tail = path.split('/').slice(-2).join('/');
      return `Nested memory — ${tail}`;
    }

    case 'mcp_instructions_delta':
      return delta('MCP servers', strArray(attachment.addedNames).length,
        strArray(attachment.removedNames).length);

    case 'agent_listing_delta':
      return delta('Agents', strArray(attachment.addedTypes).length,
        strArray(attachment.removedTypes).length);

    case 'deferred_tools_delta':
      return delta('Deferred tools',
        strArray(attachment.addedNames).length + strArray(attachment.readdedNames).length,
        strArray(attachment.removedNames).length);

    case 'skill_listing':
      // The listing is one opaque markdown blob, so any count here would be a
      // guess at its formatting. Mark the arrival; the panel shows the text.
      return str(attachment.content) ? 'Skills listing' : null;

    default:
      return null;
  }
}
