/** `status` is an open string on the wire; unknown values degrade to title case. The activity row adds the ellipsis. */
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
