// stream-json strips `isMeta`, `turnCompanion` and `sourceToolUseID`, so committed rows come only from the JSONL tail;
// the stream carries only what the CLI never writes to disk. Both sets are an on-disk census: a type found on disk must be
// dropped here or the renderer shows it twice.

// `system` is absent on purpose: it is decided per subtype below.
export const JSONL_CARRIED_TYPES: ReadonlySet<string> = new Set([
  'assistant',
  'user',
  'attachment',
  'last-prompt',
  'queue-operation',
  'atis-latch',
  'mode',
  'ai-title',
  // Persisted by `rename_session`; absent from the census.
  'custom-title',
  'pr-link',
  'permission-mode',
  'bridge-session',
  'file-history-snapshot',
  'relocated',
  'worktree-state',
  'cost-state',
]);

// compact_boundary: main still acts on it, but the renderer gets the tail's copy.
export const JSONL_CARRIED_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'stop_hook_summary',
  'compact_boundary',
  'api_error',
  'local_command',
  'turn_duration',
  'away_summary',
  'model_refusal_fallback',
]);

// A deny-list on purpose: an unknown shape forwards, so a new stream-only subtype doubles a row visibly instead of vanishing.
export function shouldForwardStreamMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return true;
  const m = raw as { type?: unknown; subtype?: unknown; parent_tool_use_id?: unknown };

  if (typeof m.type !== 'string') return true;

  // A subagent's assistant frame is written only to its agent-<id>.jsonl, so the stream is its only route.
  if (m.type === 'assistant' && typeof m.parent_tool_use_id === 'string' && m.parent_tool_use_id.length > 0) {
    return true;
  }

  if (m.type === 'system') {
    if (typeof m.subtype !== 'string') return true;
    return !JSONL_CARRIED_SYSTEM_SUBTYPES.has(m.subtype);
  }

  return !JSONL_CARRIED_TYPES.has(m.type);
}
