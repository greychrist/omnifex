/**
 * Convert the `/usage` "Resets …" label string into an absolute epoch (ms)
 * relative to when the runner observed it.
 *
 * Real labels seen in the TUI:
 *   "in 5h"
 *   "in 7d"
 *   "in 5h 23m"
 *   "9:40am (America/New_York)"
 *   "7pm (America/New_York)"
 *
 * Returns null for empty / unrecognized / invalid-timezone inputs.
 */
export function resetsLabelToEpoch(label: string, observedAtMs: number): number | null {
  const s = label.trim();
  if (!s) return null;

  if (/^in\b/i.test(s)) return parseRelative(s, observedAtMs);
  return parseClockWithTz(s, observedAtMs);
}

function parseRelative(s: string, observedAtMs: number): number | null {
  const rest = s.replace(/^in\s+/i, '');
  let totalMs = 0;
  let any = false;
  for (const m of rest.matchAll(/(\d+)\s*([dhms])\b/gi)) {
    any = true;
    const n = parseInt(m[1], 10);
    const u = m[2].toLowerCase();
    if (u === 'd') totalMs += n * 86_400_000;
    else if (u === 'h') totalMs += n * 3_600_000;
    else if (u === 'm') totalMs += n * 60_000;
    else if (u === 's') totalMs += n * 1000;
  }
  if (!any) return null;
  return observedAtMs + totalMs;
}

function parseClockWithTz(s: string, observedAtMs: number): number | null {
  // Examples: "9:40am (America/New_York)", "7pm (America/New_York)"
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)\s*$/i.exec(s);
  if (!m) return null;
  const hour12 = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3].toLowerCase();
  const tz = m[4].trim();

  if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return null;
  let hour24 = hour12 % 12; // 12am → 0, 1am..11am → 1..11
  if (ampm === 'pm') hour24 += 12; // 12pm → 12, 1pm..11pm → 13..23

  const offsetMs = tzOffsetMs(tz, observedAtMs);
  if (offsetMs == null) return null;

  // Wall-clock date in the target tz at observedAt
  const localMs = observedAtMs + offsetMs;
  const ld = new Date(localMs);
  const y = ld.getUTCFullYear();
  const mo = ld.getUTCMonth();
  const d = ld.getUTCDate();

  // Candidate "today at hour24:minute in tz" expressed as UTC epoch.
  // Adjusting for offset turns wall-clock into UTC; we recompute offset at
  // the candidate to handle DST boundaries.
  let candidateUtc = Date.UTC(y, mo, d, hour24, minute, 0) - offsetMs;
  const candidateOffset = tzOffsetMs(tz, candidateUtc);
  if (candidateOffset != null && candidateOffset !== offsetMs) {
    candidateUtc = Date.UTC(y, mo, d, hour24, minute, 0) - candidateOffset;
  }
  if (candidateUtc <= observedAtMs) {
    candidateUtc = Date.UTC(y, mo, d + 1, hour24, minute, 0) - offsetMs;
    const tomOffset = tzOffsetMs(tz, candidateUtc);
    if (tomOffset != null && tomOffset !== offsetMs) {
      candidateUtc = Date.UTC(y, mo, d + 1, hour24, minute, 0) - tomOffset;
    }
  }
  return candidateUtc;
}

/**
 * Offset (ms) such that `wallClockUtc = utcMs + offset` for the given tz at
 * the given instant. Returns null if the timezone is invalid.
 */
function tzOffsetMs(tz: string, atUtcMs: number): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(atUtcMs));
  } catch {
    return null;
  }
  const get = (t: string): number | null => {
    const p = parts.find((x) => x.type === t);
    return p ? parseInt(p.value, 10) : null;
  };
  const y = get('year');
  const mo = get('month');
  const d = get('day');
  const h = get('hour');
  const mi = get('minute');
  const se = get('second');
  if (y == null || mo == null || d == null || h == null || mi == null || se == null) return null;
  // 'h23' formats midnight as 24, but Date.UTC handles overflow correctly.
  const wallUtc = Date.UTC(y, mo - 1, d, h, mi, se);
  return wallUtc - atUtcMs;
}
