export interface UsageWindow {
  /** Open set: per-model bars come from the CLI's generic `limits` array, so never close this into a union. */
  label: string;
  pct_used: number;
  resets_at_label: string;
}

export interface UsageRow { name: string; pct_used: number }
export interface UsageTable { rows: UsageRow[]; more_count: number | null }

/** `tokens`/`per_run` keep the CLI's abbreviated text, which is lossy. `per_run` is null on narrow terminals. */
export interface UsageLoopRow {
  prompt: string;
  every: string;
  runs: number;
  tokens: string;
  per_run: string | null;
  last_run: string;
}
export interface UsageLoopsTable { rows: UsageLoopRow[]; more_count: number | null }

export interface UsageData {
  /** A cached "last-known usage" render; never record it as fresh utilization. */
  stale: boolean;
  session: {
    cost_usd: number;
    api_duration_s: number;
    wall_duration_s: number;
    code_added: number;
    code_removed: number;
    input_tokens: number;
    output_tokens: number;
    cache_read: number;
    cache_write: number;
  };
  windows: UsageWindow[];
  contributing: { headline: string; detail: string }[];
  skills: UsageTable;
  subagents: UsageTable;
  plugins: UsageTable;
  mcp_servers: UsageTable;
  loops: UsageLoopsTable;
}


export type ParseResult =
  | { ok: true; data: UsageData }
  | { ok: false; reason: string };

const SECTION_HEADERS = {
  session: /^[ \t]*Session\s*$/m,
  current_session: /^[ \t]*Current session\s*$/m,
  // Older CLIs, still possible on another account's config dir, print the old wording.
  contributing: /^[ \t]*(?:What's contributing to your usage|What's contributing to your limits usage)\?\s*$/m,
  skills_table: /^[ \t]*Skills\s+% of usage\s*$/m,
  subagents_table: /^[ \t]*Subagents\s+% of usage\s*$/m,
  plugins_table: /^[ \t]*Plugins\s+% of usage\s*$/m,
  mcp_table: /^[ \t]*MCP servers\s+% of usage\s*$/m,
  // Must be a boundary, or the last ranked table adopts the Loops `… N more` line.
  loops_table: /^[ \t]*Loops\s+every\s+runs\s+tokens\b/m,
  tables_footer: /^[ \t]*(?:f to [^\n·]*·[ \t]*)?d to day\b/m,
};

/** One regex, not a list, so a window the CLI adds later is discovered, not dropped. */
const WINDOW_HEADER = /^[ \t]*(Current session|Current week \(([^)]*)\))[ \t]*$/gm;
const ANY_WINDOW_HEADER = /^[ \t]*(?:Current session|Current week \([^)]*\))[ \t]*$/m;

export function windowLabelFor(headerText: string, modelName: string | undefined): string {
  if (modelName === undefined) return 'current_session';
  const slug = modelName
    .trim()
    .replace(/\s+only$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug ? `week_${slug}` : 'week_unknown';
}

/** Labels that earn no drift warning; not a validation gate. */
const KNOWN_WINDOW_LABELS = new Set([
  'current_session',
  'week_all_models',
  'week_sonnet',
  'week_opus',
  'week_fable',
  'week_haiku',
]);

export function rateLimitTypeForWindow(label: string): string {
  if (label === 'current_session') return 'five_hour';
  if (label === 'week_all_models') return 'seven_day';
  if (label.startsWith('week_')) return `seven_day_${label.slice('week_'.length)}`;
  return label;
}

interface FoundWindow { label: string; bodyStart: number; headerStart: number }

function findWindows(text: string): FoundWindow[] {
  const out: FoundWindow[] = [];
  const re = new RegExp(WINDOW_HEADER.source, WINDOW_HEADER.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const label = windowLabelFor(m[1], m[2]);
    if (out.some((w) => w.label === label)) continue;
    out.push({ label, headerStart: m.index, bodyStart: m.index + m[0].length });
  }
  return out;
}

/** Bound on the next header of any kind, or a trailing bar donates its `Resets` line to the window above. */
function windowBlock(text: string, windows: FoundWindow[], idx: number): string {
  let end = text.length;
  const next = windows[idx + 1];
  if (next) end = next.headerStart;
  const contributing = new RegExp(SECTION_HEADERS.contributing.source, SECTION_HEADERS.contributing.flags)
    .exec(text.slice(windows[idx].bodyStart));
  if (contributing != null) {
    end = Math.min(end, windows[idx].bodyStart + contributing.index);
  }
  return text.slice(windows[idx].bodyStart, end);
}

// Every variant ("rate limited …", "could not refresh") shares this prefix.
const STALE_MARKER = /^[ \t]*Showing last-known usage/m;

export function isUsageOutputComplete(input: string): boolean {
  const result = parseUsageOutput(input);
  if (!result.ok) return false;

  // Enterprise/Console renders draw no window headers; the tables footer is the last thing drawn.
  const text = input.replace(/\r\n/g, '\n');
  if (!ANY_WINDOW_HEADER.test(text)) {
    return SECTION_HEADERS.tables_footer.test(text);
  }

  // Per-model bars are an open set, so none is required by name; the contributing header renders below every window.
  // A 0%-used window omits its Resets line.
  for (const label of ['current_session', 'week_all_models']) {
    if (!result.data.windows.some((w) => w.label === label)) return false;
  }
  if (!SECTION_HEADERS.contributing.test(text)) return false;
  for (const w of result.data.windows) {
    if (w.pct_used > 0 && !w.resets_at_label.trim()) return false;
  }
  return true;
}

// Label-only probes, so "wording changed" is distinguishable from "value is 0". Keep in sync with `parseSessionBlock`.
const SESSION_FIELD_LABELS: { label: string; re: RegExp }[] = [
  // Current CLIs print "Estimated cost:"; older ones, still possible on another account's config dir, print "Total cost:".
  { label: 'Total cost:', re: /(?:Total cost|Estimated cost):/ },
  { label: 'Total duration (API):', re: /Total duration \(API\):/ },
  { label: 'Total duration (wall):', re: /Total duration \(wall\):/ },
  { label: 'Total code changes:', re: /Total code changes:/ },
  { label: 'Usage:', re: /Usage:/ },
];

/**
 * `parseSessionBlock` maps "label missing" and "value is 0" to the same 0; this surfaces reworded labels.
 * A label is flagged only when its parent section is present.
 */
export function collectUsageDriftWarnings(input: string): string[] {
  const text = input.replace(/\r\n/g, '\n');
  const warnings: string[] = [];

  if (SECTION_HEADERS.session.test(text)) {
    const block = sliceSection(
      text,
      SECTION_HEADERS.session,
      ANY_WINDOW_HEADER,
      SECTION_HEADERS.contributing,
    ) ?? '';
    for (const { label, re } of SESSION_FIELD_LABELS) {
      if (!re.test(block)) {
        warnings.push(
          `session field label not found: "${label}" — storing 0; likely CLI wording drift`,
        );
      }
    }
  }

  const found = findWindows(text);
  for (let i = 0; i < found.length; i += 1) {
    const label = found[i].label;
    const block = windowBlock(text, found, i);
    if (!/(\d+(?:\.\d+)?)\s*%\s*used/i.test(block)) {
      warnings.push(
        `window "${label}" header found but no "% used" line; likely CLI wording drift`,
      );
    }
  }

  // An unknown label flows through but warns: a mangled header becomes a junk `seven_day_*` type.
  for (const w of found) {
    if (!KNOWN_WINDOW_LABELS.has(w.label)) {
      warnings.push(
        `unrecognised rate-limit window "${w.label}" — new CLI window (fine) or a mangled header (not fine); ` +
          `it will be stored as rate-limit type "${rateLimitTypeForWindow(w.label)}"`,
      );
    }
  }

  return warnings;
}

export function parseUsageOutput(input: string): ParseResult {
  const text = input.replace(/\r\n/g, '\n');

  const session = parseSessionBlock(text);
  const windows: UsageWindow[] = [];
  const found = findWindows(text);
  for (let i = 0; i < found.length; i += 1) {
    const w = parseWindow(windowBlock(text, found, i), found[i].label);
    if (w) windows.push(w);
  }

  // Enterprise/Console renders have no windows, only the contributing section.
  const hasContributing = SECTION_HEADERS.contributing.test(text);
  if (windows.length === 0 && !hasContributing) {
    return { ok: false, reason: 'no_windows' };
  }

  const contributing = parseContributing(text);
  const skills = parseTable(text, SECTION_HEADERS.skills_table);
  const subagents = parseTable(text, SECTION_HEADERS.subagents_table);
  const plugins = parseTable(text, SECTION_HEADERS.plugins_table);
  const mcp_servers = parseTable(text, SECTION_HEADERS.mcp_table);
  const loops = parseLoops(text);

  return {
    ok: true,
    data: {
      stale: STALE_MARKER.test(text),
      session, windows, contributing, skills, subagents, plugins, mcp_servers,
      loops,
    },
  };
}

function sliceSection(text: string, startRe: RegExp, ...nextRes: RegExp[]): string | null {
  const re = new RegExp(startRe.source, startRe.flags);
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  let end = text.length;
  for (const nre of nextRes) {
    const re2 = new RegExp(nre.source, nre.flags);
    re2.lastIndex = start;
    const n = re2.exec(text.slice(start));
    if (n != null) {
      const candidate = start + n.index;
      if (candidate < end) end = candidate;
    }
  }
  return text.slice(start, end);
}

function parseSessionBlock(text: string): UsageData['session'] {
  const block = sliceSection(
    text,
    SECTION_HEADERS.session,
    ANY_WINDOW_HEADER,
    SECTION_HEADERS.contributing,
  ) ?? '';

  const cost = /(?:Total cost|Estimated cost):\s*\$([\d.]+)/.exec(block)?.[1];
  const apiD = /Total duration \(API\):\s*([\d.]+)\s*s/.exec(block)?.[1];
  const wallD = /Total duration \(wall\):\s*([\d.]+)\s*s/.exec(block)?.[1];
  const codeChange = /Total code changes:\s*([\d,]+)\s*lines added,\s*([\d,]+)\s*lines removed/.exec(block);
  const usage = /Usage:\s*([\d,]+)\s*input,\s*([\d,]+)\s*output,\s*([\d,]+)\s*cache read,\s*([\d,]+)\s*cache write/.exec(block);

  const num = (s: string | undefined): number => (s ? parseFloat(s.replace(/,/g, '')) : 0);
  const intnum = (s: string | undefined): number => (s ? parseInt(s.replace(/,/g, ''), 10) : 0);

  return {
    cost_usd: num(cost),
    api_duration_s: num(apiD),
    wall_duration_s: num(wallD),
    code_added: intnum(codeChange?.[1]),
    code_removed: intnum(codeChange?.[2]),
    input_tokens: intnum(usage?.[1]),
    output_tokens: intnum(usage?.[2]),
    cache_read: intnum(usage?.[3]),
    cache_write: intnum(usage?.[4]),
  };
}

function parseWindow(block: string, label: string): UsageWindow | null {
  const pct = /(\d+(?:\.\d+)?)\s*%\s*used/i.exec(block)?.[1];
  if (pct == null) return null;
  const resetsLine = /Resets\s+(.+?)\s*$/m.exec(block)?.[1]?.trim();
  return {
    label,
    pct_used: parseFloat(pct),
    resets_at_label: resetsLine ?? '',
  };
}

function parseTable(text: string, header: RegExp): UsageTable {
  const block = sliceSection(
    text,
    header,
    SECTION_HEADERS.skills_table,
    SECTION_HEADERS.subagents_table,
    SECTION_HEADERS.plugins_table,
    SECTION_HEADERS.mcp_table,
    SECTION_HEADERS.loops_table,
    SECTION_HEADERS.tables_footer,
  );
  if (!block) return { rows: [], more_count: null };
  const rows: UsageRow[] = [];
  let more_count: number | null = null;
  const ROW_RE = /^\s*(\S(?:.*\S)?)\s+(\d+(?:\.\d+)?)%\s*$/;
  const MORE_RE = /^\s*…\s*(\d+)\s+more\s*$/;
  for (const raw of block.split('\n')) {
    const m = ROW_RE.exec(raw);
    if (m) {
      rows.push({ name: m[1], pct_used: parseFloat(m[2]) });
      continue;
    }
    const moreMatch = MORE_RE.exec(raw);
    if (moreMatch) {
      more_count = parseInt(moreMatch[1], 10);
    }
  }
  return { rows, more_count };
}

/** Cells are separated by 2+ spaces. Anchor on `runs`, the only bare integer: narrow terminals drop `per run`. */
function parseLoops(text: string): UsageLoopsTable {
  const block = sliceSection(
    text,
    SECTION_HEADERS.loops_table,
    SECTION_HEADERS.tables_footer,
  );
  if (!block) return { rows: [], more_count: null };

  const rows: UsageLoopRow[] = [];
  let more_count: number | null = null;
  const MORE_RE = /^\s*…\s*(\d+)\s+more\s*$/;
  for (const raw of block.split('\n')) {
    const moreMatch = MORE_RE.exec(raw);
    if (moreMatch) {
      more_count = parseInt(moreMatch[1], 10);
      continue;
    }
    const fields = raw.trim().split(/\s{2,}/);
    if (fields.length < 4) continue;
    const runsIdx = fields.findIndex((f, i) => i >= 1 && /^\d+$/.test(f));
    // A long prompt swallows the gap after it; skip rather than shift every later column.
    if (runsIdx < 2 || runsIdx + 1 >= fields.length) continue;
    const trailing = fields.slice(runsIdx + 2);
    rows.push({
      prompt: fields.slice(0, runsIdx - 1).join(' '),
      every: fields[runsIdx - 1],
      runs: parseInt(fields[runsIdx], 10),
      tokens: fields[runsIdx + 1],
      per_run: trailing.length >= 2 ? trailing[0] : null,
      last_run: trailing.length > 0 ? trailing[trailing.length - 1] : '',
    });
  }
  return { rows, more_count };
}

function parseContributing(text: string): { headline: string; detail: string }[] {
  const block = sliceSection(
    text,
    SECTION_HEADERS.contributing,
    SECTION_HEADERS.skills_table,
    SECTION_HEADERS.subagents_table,
    SECTION_HEADERS.plugins_table,
    SECTION_HEADERS.mcp_table,
    SECTION_HEADERS.loops_table,
    SECTION_HEADERS.tables_footer,
  ) ?? '';
  const lines = block.split('\n');
  const out: { headline: string; detail: string }[] = [];
  let current: { headline: string; detail: string[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    out.push({ headline: current.headline, detail: current.detail.join(' ').trim() });
    current = null;
  };
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    // Stacked redraw frames can put a glyph-less "0% used" bar here; it is not a headline.
    if (/^\d+(?:\.\d+)?%\s*used\s*$/.test(trimmed)) continue;
    if (/^\d+%/.test(trimmed)) {
      flush();
      current = { headline: trimmed, detail: [] };
    } else if (current) {
      current.detail.push(trimmed);
    }
  }
  flush();
  return out;
}
