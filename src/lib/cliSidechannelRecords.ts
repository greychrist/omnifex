/**
 * The record types the CLI writes into the session JSONL that are not
 * messages — conversation latches and bookkeeping it keeps for itself.
 *
 * The CLI's own merge-strategy map (verified in 2.1.270) is the source of
 * this list. Exactly four types there are marked `"transcript"` — `user`,
 * `assistant`, `system`, `attachment` — and every other entry is per-session
 * state carried across turns, branches and compaction: `"last-wins"` for a
 * latch, `"accumulate"` for a log, `"boundary-cleared"` for something a
 * compaction resets. `atis-latch` is one of the latches: an opaque token the
 * CLI pins to a conversation and re-emits on every branch write, which is why
 * 379 of them landed in twelve sessions and every one drew an orange
 * "Unrecognized record: atis-latch" card.
 *
 * To refresh after a CLI upgrade, read the map out of the bundle:
 *
 *   rg -a -o '\{[^{}]{0,1200}"ended-by-model":"last-wins"[^{}]{0,600}\}' \
 *     ~/.local/share/claude/versions/<version>
 *
 * Deliberately NOT here, though the CLI classifies them the same way:
 *
 *  - `queue-operation`, `last-prompt`, `permission-mode`, `ai-title` and
 *    `file-history-snapshot` — `classifyJsonlLine` gives each its own kind
 *    and something in the app reads it.
 *  - `summary` — it rides the `unknown` kind but `StreamMessage` renders it
 *    as the compaction SummaryWidget. It is a message in all but type.
 *
 * A type the CLI adds later and this list does not know still draws the
 * catch-all card, and that is the intent: an unfamiliar record is worth
 * seeing once. This list is how it stops being worth seeing 379 times.
 */
export const CLI_SIDECHANNEL_RECORD_TYPES: ReadonlySet<string> = new Set([
  // Conversation latches — per-session state, last one wins.
  'atis-latch',
  'isolation-latch',
  'mode',
  'worktree-state',
  'cost-state',
  'attribution-snapshot',
  'history-suppression',
  'bridge-session',
  'observer-ref',
  'ended-by-model',
  'custom-title',
  'tag',
  'relocated',
  'agent-name',
  'agent-color',
  'agent-setting',
  'pr-link',
  'artifact-comment-monitor',
  'artifact-autoreact-ledger',
  // Structural bookkeeping — branch plumbing and file-history deltas.
  'file-history-delta',
  'continued-in',
  'content-replacement',
  'fork-context-ref',
  'frame-link',
  'marble-origami-commit',
  'marble-origami-snapshot',
  'marble-origami-reset',
]);

/** Whether a raw JSONL record is CLI bookkeeping rather than a message. */
export function isCliSidechannelRecord(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const type = (raw as { type?: unknown }).type;
  return typeof type === 'string' && CLI_SIDECHANNEL_RECORD_TYPES.has(type);
}
