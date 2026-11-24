// Folds what the CLI actually loaded (attachment records); never walk the disk.
// Pure and idempotent: no Date.now(), no IO, no module state.

import type { JsonlNode } from '@/types/jsonl';

export type ContextEntryKind =
  | 'instruction-file'
  | 'nested-memory'
  | 'mcp-server'
  | 'agent'
  | 'skills'
  | 'deferred-tool'
  | 'project-doc'
  | 'plugin-note';

/** Open: the CLI adds scopes; unknown ones pass through. */
export type ContextScope =
  | 'User' | 'Project' | 'Local' | 'Managed' | 'AutoMem'
  | (string & {});

export interface LedgerEntry {
  /** Not unique: an out-and-back yields two entries sharing an id. */
  id: string;
  kind: ContextEntryKind;
  label: string;
  scope?: ContextScope;
  content?: string;
  at: string;
  live: boolean;
  endedAt?: string;
}

export interface ContextLedger {
  entries: LedgerEntry[];
  liveCount: number;
  /** False before the CLI emitted these records: say so, never render an empty list. */
  tracked: boolean;
  startedAt: string | null;
}

export const CONTEXT_TRACKING_SINCE = '2026-09-08';

const IN_SCOPE = new Set([
  'instructions',
  'nested_memory',
  'mcp_instructions_delta',
  'agent_listing_delta',
  'deferred_tools_delta',
  'skill_listing',
  'project_doc_reads',
  'plugin_note',
]);

/** Null while held: content [] with only heldContent has not reached the model. */
function pluginNoteText(att: Record<string, unknown>): string | null {
  const lines = strArray(att.content);
  return lines.length === 0 ? null : lines.join('\n');
}

function pluginNoteSource(att: Record<string, unknown>): string {
  return str(att.plugin) ?? 'a plugin';
}

function projectDocOf(v: unknown): { path: string; content?: string } | null {
  if (!v || typeof v !== 'object') return null;
  const read = (v as { read?: unknown }).read;
  if (!read || typeof read !== 'object') return null;
  const path = str((read as Record<string, unknown>).path);
  if (!path) return null;
  return { path, content: str((read as Record<string, unknown>).content) };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

function scopeOf(v: unknown): ContextScope | undefined {
  return str(v);
}

export function foldContextLedger(records: readonly JsonlNode[]): ContextLedger {
  const entries: LedgerEntry[] = [];
  let tracked = false;
  let startedAt: string | null = null;

  const liveIdx = new Map<string, number>();

  const open = (
    kind: ContextEntryKind,
    label: string,
    at: string,
    extra?: { scope?: ContextScope; content?: string; id?: string },
  ) => {
    const id = extra?.id ?? `${kind}:${label}`;
    if (liveIdx.has(id)) return;
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

  const retainOnly = (kind: ContextEntryKind, keep: Set<string>, at: string) => {
    for (const [id, idx] of [...liveIdx.entries()]) {
      const e = entries[idx];
      if (e.kind !== kind || keep.has(e.label)) continue;
      entries[idx] = { ...e, live: false, endedAt: at };
      liveIdx.delete(id);
    }
  };

  for (const rec of records) {
    if (startedAt === null && (rec.kind === 'user' || rec.kind === 'assistant')) {
      startedAt = rec.receivedAt;
    }
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
        retainOnly('instruction-file', keep, at);
        break;
      }

      case 'nested_memory': {
        // `path` is at the top level and inside `content`; only the nested copy carries the scope.
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
        for (const name of strArray(att.readdedNames)) open('deferred-tool', name, at);
        break;
      }

      case 'project_doc_reads': {
        for (const doc of (Array.isArray(att.reads) ? att.reads : []).map(projectDocOf)) {
          if (!doc) continue;
          const idx = liveIdx.get(`project-doc:${doc.path}`);
          if (idx !== undefined && entries[idx].content !== doc.content) close('project-doc', doc.path, at);
          open('project-doc', doc.path, at, { content: doc.content });
        }
        break;
      }

      case 'plugin_note': {
        // Keyed by rowUuid: one plugin leaves several notes, and a restored copy repeats its rowUuid.
        const content = pluginNoteText(att);
        if (content === null) break;
        const row = str(att.rowUuid) ?? content;
        open('plugin-note', pluginNoteSource(att), at, { content, id: `plugin-note:${row}` });
        break;
      }

      case 'skill_listing': {
        const content = str(att.content);
        if (content === undefined) break;
        retainOnly('skills', new Set([content]), at);
        open('skills', content, at, { content });
        break;
      }
    }
  }

  return { entries, liveCount: liveIdx.size, tracked, startedAt };
}

export function summariseContextAttachment(
  attachment: Record<string, unknown> | undefined,
): string | null {
  const type = str(attachment?.type);
  if (!attachment || !type || !IN_SCOPE.has(type)) return null;

  /** U+2212 minus, not a hyphen. */
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

    case 'plugin_note':
      return pluginNoteText(attachment) === null ? null : `Plugin note — ${pluginNoteSource(attachment)}`;

    case 'project_doc_reads': {
      const n = (Array.isArray(attachment.reads) ? attachment.reads : []).map(projectDocOf).filter(Boolean).length;
      return n === 0 ? null : `Project docs — ${n} read`;
    }

    case 'skill_listing':
      return str(attachment.content) ? 'Skills listing' : null;

    default:
      return null;
  }
}
