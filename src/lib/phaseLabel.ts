/**
 * Maps a Claude CLI `system:status` message's `status` field to a short
 * human label for the live activity row (e.g. "Requesting", "Compacting
 * context"). The activity row appends its own trailing ellipsis, so labels
 * here carry none.
 *
 * `status` is an OPEN STRING on the wire: the docs only list `compacting`
 * (and `null`), but the CLI emits others in practice (e.g. `requesting`).
 * Known values get a curated label; anything else degrades to a title-cased
 * version of the raw value so a future status the CLI starts emitting still
 * shows something sensible instead of disappearing.
 */
const KNOWN_LABELS: Record<string, string> = {
  requesting: 'Requesting',
  compacting: 'Compacting context',
};

export function phaseLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  const trimmed = status.trim();
  if (trimmed === '') return null;

  const known = KNOWN_LABELS[trimmed];
  if (known) return known;

  const spaced = trimmed.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
