export interface UsageWindow {
  label: 'current_session' | 'week_all_models' | 'week_sonnet';
  pct_used: number;
  resets_at_label: string;
}

export interface UsageRow { name: string; pct_used: number }
export interface UsageTable { rows: UsageRow[]; more_count: number | null }

export interface UsageData {
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
  /**
   * Three ranked tables Claude shows beneath "What's contributing" — see
   * notes on `UsageRunData.skills` in `src/lib/api.ts` for shape details.
   */
  skills: UsageTable;
  subagents: UsageTable;
  plugins: UsageTable;
}


export type ParseResult =
  | { ok: true; data: UsageData }
  | { ok: false; reason: string };

// Section headers in the real TUI are indented (~2 spaces). The CLI also
// emits a row of tab labels (`Status   Config   Usage   Stats`) above the
// `Session` block, so we anchor on header text rather than column zero.
//
// `week_sonnet` is intentionally fuzzy. As of Claude Code 2.1.132 the
// Sonnet block is rendered asynchronously over a "Refreshing…" placeholder
// using cursor-position overwrites, which our linear ANSI strip can't
// replicate — the literal text "Sonnet only" arrives corrupted (e.g.
// "Son et nly", chars dropped). The leading `Son` and the surrounding
// parens have been stable across observed corruptions, and matches are
// disambiguated from `(all models)` by requiring "Son" inside the parens.
// If a future version drops the `S` too, weaken further.
const SECTION_HEADERS = {
  session: /^[ \t]*Session\s*$/m,
  current_session: /^[ \t]*Current session\s*$/m,
  week_all_models: /^[ \t]*Current week \(all models\)\s*$/m,
  week_sonnet: /^[ \t]*Current week \(\s*Son[^)]*\)\s*$/m,
  contributing: /^[ \t]*What's contributing to your limits usage\?\s*$/m,
  skills_table: /^[ \t]*Skills\s+% of usage\s*$/m,
  subagents_table: /^[ \t]*Subagents\s+% of usage\s*$/m,
  plugins_table: /^[ \t]*Plugins\s+% of usage\s*$/m,
  // Footer hint Claude prints after the tables ("d to day · w to week").
  // Used as a hard end-boundary for the last table.
  tables_footer: /^[ \t]*d to day\b/m,
};

/**
 * Returns true when the captured TUI text appears to be a complete `/usage`
 * render: all three known window sections are present, each has a `% used`
 * line and a non-empty `Resets ...` line. Used by the runner as a fast-path
 * exit signal — no need to wait the full quiet timeout if the buffer is
 * already complete. Returns false (keep waiting) if any section is missing or
 * still in mid-render.
 */
export function isUsageOutputComplete(input: string): boolean {
  const result = parseUsageOutput(input);
  if (!result.ok) return false;
  // All three known windows must have parsed. A non-empty Resets line is
  // required EXCEPT for 0%-used windows — observed in Claude Code 2.1.148:
  // when Sonnet usage is 0%, the TUI renders the header + bar but omits the
  // Resets line entirely (nothing to reset to). Without the carve-out the
  // fast-path would never fire for that common case, forcing every poll to
  // wait the full quiet timeout.
  //
  // If a future CLI version emits more sections we still pass; if it emits
  // fewer (e.g. free-tier accounts that only show the session window), the
  // fast-path stays disabled and the runner falls back to the quiet timeout.
  const required: UsageWindow['label'][] = ['current_session', 'week_all_models', 'week_sonnet'];
  for (const label of required) {
    const w = result.data.windows.find((w) => w.label === label);
    if (!w) return false;
    if (w.pct_used > 0 && !w.resets_at_label.trim()) return false;
  }
  return true;
}

// The five session-block field labels the CLI always renders inside a
// `Session` block (even on a fresh session, at $0.00 / 0). These are
// LABEL-ONLY probes — no value capture — so they detect "the wording
// changed" independently of "the value is genuinely 0". Keep this list in
// sync with the value-capturing regexes in `parseSessionBlock`.
const SESSION_FIELD_LABELS: { label: string; re: RegExp }[] = [
  { label: 'Total cost:', re: /Total cost:/ },
  { label: 'Total duration (API):', re: /Total duration \(API\):/ },
  { label: 'Total duration (wall):', re: /Total duration \(wall\):/ },
  { label: 'Total code changes:', re: /Total code changes:/ },
  { label: 'Usage:', re: /Usage:/ },
];

/**
 * Audit a `/usage` render for *silent* label drift — cases where the parser
 * still returns `ok: true` but a value it extracted is a default-zero because
 * the CLI reworded a label, not because usage was genuinely zero.
 *
 * `parseSessionBlock` collapses "label not found" and "value is 0" into the
 * same `0`, so a reworded `Total cost:` → `Total spend:` silently stores $0
 * with no error signal. Same for a window whose `% used` phrasing changes.
 * This returns human-readable warnings the runner logs at `warn` level, so the
 * next CLI drift surfaces in the Log tab the same loud-but-harmless way the
 * welcome-footer marker drift already does — instead of masquerading as real
 * zero usage.
 *
 * Conservative by design: a label is only flagged when its PARENT section is
 * present. A free-tier or partial render that legitimately omits the `Session`
 * block (or a whole window) is a different, already-tolerated shape — not
 * drift — so it produces no warnings and no false alarms.
 */
export function collectUsageDriftWarnings(input: string): string[] {
  const text = input.replace(/\r\n/g, '\n');
  const warnings: string[] = [];

  // Session block: present header ⇒ every field label below is expected.
  if (SECTION_HEADERS.session.test(text)) {
    const block = sliceSection(
      text,
      SECTION_HEADERS.session,
      SECTION_HEADERS.current_session,
      SECTION_HEADERS.week_all_models,
      SECTION_HEADERS.week_sonnet,
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

  // Windows: a matched header should be followed by a `% used` line. A header
  // without one means the usage-bar phrasing drifted.
  const windowHeaders: [UsageWindow['label'], RegExp][] = [
    ['current_session', SECTION_HEADERS.current_session],
    ['week_all_models', SECTION_HEADERS.week_all_models],
    ['week_sonnet', SECTION_HEADERS.week_sonnet],
  ];
  for (const [label, header] of windowHeaders) {
    if (!header.test(text)) continue;
    const block = sliceSection(
      text,
      header,
      SECTION_HEADERS.current_session,
      SECTION_HEADERS.week_all_models,
      SECTION_HEADERS.week_sonnet,
      SECTION_HEADERS.contributing,
    ) ?? '';
    if (!/(\d+(?:\.\d+)?)\s*%\s*used/i.test(block)) {
      warnings.push(
        `window "${label}" header found but no "% used" line; likely CLI wording drift`,
      );
    }
  }

  return warnings;
}

export function parseUsageOutput(input: string): ParseResult {
  const text = input.replace(/\r\n/g, '\n');

  const session = parseSessionBlock(text);
  const windows: UsageWindow[] = [];
  const cs = parseWindow(text, 'current_session', SECTION_HEADERS.current_session);
  if (cs) windows.push(cs);
  const wm = parseWindow(text, 'week_all_models', SECTION_HEADERS.week_all_models);
  if (wm) windows.push(wm);
  const ws = parseWindow(text, 'week_sonnet', SECTION_HEADERS.week_sonnet);
  if (ws) windows.push(ws);

  if (windows.length === 0) return { ok: false, reason: 'no_windows' };

  const contributing = parseContributing(text);
  const skills = parseTable(text, SECTION_HEADERS.skills_table);
  const subagents = parseTable(text, SECTION_HEADERS.subagents_table);
  const plugins = parseTable(text, SECTION_HEADERS.plugins_table);

  return {
    ok: true,
    data: { session, windows, contributing, skills, subagents, plugins },
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
    SECTION_HEADERS.current_session,
    SECTION_HEADERS.week_all_models,
    SECTION_HEADERS.week_sonnet,
    SECTION_HEADERS.contributing,
  ) ?? '';

  const cost = /Total cost:\s*\$([\d.]+)/.exec(block)?.[1];
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

function parseWindow(
  text: string,
  label: UsageWindow['label'],
  header: RegExp,
): UsageWindow | null {
  const block = sliceSection(
    text,
    header,
    SECTION_HEADERS.current_session,
    SECTION_HEADERS.week_all_models,
    SECTION_HEADERS.week_sonnet,
    SECTION_HEADERS.contributing,
  );
  if (!block) return null;
  const pct = /(\d+(?:\.\d+)?)\s*%\s*used/i.exec(block)?.[1];
  if (pct == null) return null;
  const resetsLine = /Resets\s+(.+?)\s*$/m.exec(block)?.[1]?.trim();
  return {
    label,
    pct_used: parseFloat(pct),
    resets_at_label: resetsLine ?? '',
  };
}

/**
 * Parses one of Claude's three "% of usage" ranked tables (Skills /
 * Subagents / Plugins). Each table has the shape:
 *
 *   <Title> % of usage
 *   <name1> <pct1>%
 *   <name2> <pct2>%
 *   …
 *   … <N> more         (optional, when truncated)
 *
 * Names may contain `:` `/` `-` `…` and other URL-safe punctuation, but no
 * spaces. We capture from the start of the trimmed line up to the last
 * whitespace before the percent, which keeps multi-token names intact if
 * Claude ever introduces them. Returns `{ rows: [], more_count: null }`
 * when the header isn't found, so downstream renderers can collapse
 * absent tables (e.g. on accounts with no relevant data) without
 * conditional checks.
 */
function parseTable(text: string, header: RegExp): UsageTable {
  // Scope the slice to "from this header until the next table header /
  // tables footer / end-of-text". `What's contributing` (and earlier
  // sections) are always above the tables in the real TUI, so we don't
  // need to bound on those.
  const block = sliceSection(
    text,
    header,
    SECTION_HEADERS.skills_table,
    SECTION_HEADERS.subagents_table,
    SECTION_HEADERS.plugins_table,
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

function parseContributing(text: string): { headline: string; detail: string }[] {
  const block = sliceSection(text, SECTION_HEADERS.contributing) ?? '';
  // Each entry starts with a percent-headed headline (e.g. "86% of your usage
  // was at >150k context"), followed by one or more wrapped detail lines that
  // we collapse into a single paragraph. Both headline and detail lines may
  // be indented; we differentiate by whether the trimmed line begins with a
  // percentage. Blank lines terminate the current entry.
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
    // Skip a bare "N% used" usage-bar label outright — neither headline nor
    // detail. The pty buffer stacks multiple redraw frames, and because the
    // first "What's contributing" header can sit in an earlier frame, this
    // slice spans into a later frame's window block. A bar-FILLED window line
    // ("████ 17% used") is already disqualified by its leading glyph, but a
    // 0%-used window renders a glyph-less "0% used" that would otherwise match
    // the percent-headline test below and inject a bogus contributing entry.
    if (/^\d+(?:\.\d+)?%\s*used\s*$/.test(trimmed)) continue;
    if (/^\d+%/.test(trimmed)) {
      flush();
      current = { headline: trimmed, detail: [] };
    } else if (current) {
      current.detail.push(trimmed);
    }
    // Lines before the first headline (e.g. the "Approximate, based on…" and
    // "Last 24h …" preamble) are ignored.
  }
  flush();
  return out;
}
