// Sessions module — stream-json forwarding decision (transcript inversion)
//
// The CLI reports each session twice: the stream-json it writes to stdout,
// and the JSONL transcript it appends on disk. The two are not equivalent —
// stream-json is the same events with fields stripped, notably `isMeta`,
// `turnCompanion` and `sourceToolUseID`. Rendering from the stripped copy is
// what forced classifiers to guess a record's role from its neighbours, and
// what made a re-invoked skill's SKILL.md body render as a user prompt when
// CLI 2.1.270 started emitting two companion records instead of one.
//
// So the JSONL is the sole source of committed transcript rows, delivered by
// the tail (see jsonl-tail.ts). This predicate decides
// what is left for stream-json to carry: only the shapes the CLI never writes
// to disk.
//
// Both sets below are empirical, not guessed — a census of every record in
// all 890 session transcripts under the personal config dir. Anything found
// on disk is a row the tail will deliver, so the stream's copy must be
// dropped or the renderer shows it twice.

/**
 * Top-level `type` values the CLI persists to the JSONL. The stream's copy of
 * each is redundant once the tail is the transcript source.
 *
 * `system` is deliberately absent: it carries both on-disk subtypes
 * (stop_hook_summary, compact_boundary, …) and stream-only ones (init,
 * hook_started, …), so that decision is made per subtype below.
 */
export const JSONL_CARRIED_TYPES: ReadonlySet<string> = new Set([
  'assistant',
  'user',
  'attachment',
  'last-prompt',
  'queue-operation',
  'atis-latch',
  'mode',
  'ai-title',
  // Not from the census — no transcript had one until the app could rename
  // a session. Verified against CLI 2.1.273: `rename_session` persists it.
  'custom-title',
  'pr-link',
  'permission-mode',
  'bridge-session',
  'file-history-snapshot',
  'relocated',
  'worktree-state',
  'cost-state',
]);

/**
 * `system` subtypes the CLI persists. Everything else under `system` — init,
 * the hook lifecycle, task_started/task_notification, thinking_tokens,
 * permission_denied — appears zero times on disk and reaches the renderer
 * only via the stream.
 *
 * compact_boundary is the subtle member: main still classifies it to drive
 * the compact hint (see classifyRuntimeEvent), but the renderer receives its
 * copy from the tail, so forwarding the stream's copy would duplicate it.
 * Acting on an event and forwarding it are separate decisions.
 */
export const JSONL_CARRIED_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'stop_hook_summary',
  'compact_boundary',
  'api_error',
  'local_command',
  'turn_duration',
  'away_summary',
  'model_refusal_fallback',
]);

/**
 * True when a stream-json message should still reach the renderer.
 *
 * This is a DENY-list, and the direction is the point. An unrecognised shape
 * forwards: if the CLI adds a stream-only subtype after this was written,
 * forwarding it may double a row — loud, and obvious on screen. Dropping it
 * would remove it from the UI with nothing to notice, which is the exact
 * failure mode this change exists to eliminate. Fail toward the visible bug.
 *
 * (Same reasoning as the subtractive rpc allow-list in electron/remote/
 * rpc-allowlist.ts: a new channel is reachable by default and must be denied
 * deliberately.)
 */
export function shouldForwardStreamMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return true;
  const m = raw as { type?: unknown; subtype?: unknown };

  if (typeof m.type !== 'string') return true;

  if (m.type === 'system') {
    if (typeof m.subtype !== 'string') return true;
    return !JSONL_CARRIED_SYSTEM_SUBTYPES.has(m.subtype);
  }

  return !JSONL_CARRIED_TYPES.has(m.type);
}
