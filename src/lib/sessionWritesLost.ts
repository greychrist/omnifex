/**
 * The text for `system/session_writes_lost` (CLI >= 2.1.317): sent once, as
 * the CLI exits, when a full disk or used-up quota lost lines of a session
 * transcript, changes to ~/.claude.json, or both. The CLI writes the same
 * explanation to stderr; this is the stream-json frame of it, reworded for
 * the card the way the CLI words it there.
 */
export function sessionWritesLostText(raw: unknown): string {
  const r = (raw ?? {}) as { error_code?: unknown; lost?: unknown };
  const lost = Array.isArray(r.lost) ? r.lost : [];
  const transcript = lost.includes('transcript');
  const config = lost.includes('global_config');
  const what = [
    transcript ? "part of this session's transcript" : null,
    config ? 'its changes to ~/.claude.json' : null,
  ].filter(Boolean).join(' and ') || 'some of its writes';
  const cause = r.error_code === 'EDQUOT' ? 'the disk quota is used up' : r.error_code === 'ENOSPC' ? 'the disk is full' : null;
  const fix = r.error_code === 'EDQUOT'
    ? 'Free up space, or ask for a larger quota, before the next run.'
    : r.error_code === 'ENOSPC' ? 'Free up space on that disk before the next run.' : null;
  return [
    `Claude Code couldn't save ${what}${cause ? `: ${cause}` : ''}.`,
    transcript ? 'Resuming this session may miss part of the conversation.' : null,
    fix,
  ].filter(Boolean).join(' ');
}
