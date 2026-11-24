/**
 * Non-message JSONL types, from the CLI's merge-strategy map (every type not marked "transcript"). Refresh:
 *   rg -a -o '\{[^{}]{0,1200}"ended-by-model":"last-wins"[^{}]{0,600}\}' ~/.local/share/claude/versions/<version>
 * Never add a type classifyJsonlLine gives its own kind, `custom-title` (a rename lands as it), or `summary`
 * (rendered as the compaction widget).
 */
export const CLI_SIDECHANNEL_RECORD_TYPES: ReadonlySet<string> = new Set([
  'atis-latch',
  'tools-used',
  'isolation-latch',
  'mode',
  'memory-mode',
  'worktree-state',
  'cost-state',
  'attribution-snapshot',
  'history-suppression',
  'bridge-session',
  'observer-ref',
  'ended-by-model',
  'tag',
  'relocated',
  'agent-name',
  'agent-color',
  'agent-setting',
  'pr-link',
  'artifact-comment-monitor',
  'artifact-autoreact-ledger',
  'dev-mods',
  'session-owner',
  'repl-mode',
  'hybrid-organization',
  'host-row',
  'file-history-delta',
  'continued-in',
  'resume-head-vouch',
  'content-replacement',
  'data-flow-records',
  'data-flow-incomplete',
  'derived-from',
  'fork-context-ref',
  'frame-link',
  'api-request',
  'api-request-shape',
  'api-request-blob',
  'api-request-resumed',
  // Dropped from the CLI's map in 2.1.276; older transcripts still carry them.
  'marble-origami-commit',
  'marble-origami-snapshot',
  'marble-origami-reset',
]);

export function isCliSidechannelRecord(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const type = (raw as { type?: unknown }).type;
  return typeof type === 'string' && CLI_SIDECHANNEL_RECORD_TYPES.has(type);
}
