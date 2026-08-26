export interface UsageWindow {
  /**
   * `current_session`, `week_all_models`, or `week_<model>` for a per-model
   * weekly bar. Deliberately a string rather than a closed union: the CLI
   * renders per-model windows from a generic `limits` array, so the set grows
   * without warning. 2.1.236 renders `Current week (Fable)` on accounts that
   * previously only ever showed `(Sonnet only)`, and a closed union silently
   * dropped it. Consumers map unknown labels through `rateLimitTypeForWindow`
   * and fall back to showing the raw label.
   */
  label: string;
  pct_used: number;
  resets_at_label: string;
}

export interface UsageRow { name: string; pct_used: number }
export interface UsageTable { rows: UsageRow[]; more_count: number | null }

/**
 * One row of the `/usage` Loops breakdown (Claude Code 2.1.243+).
 *
 * Only `runs` is numeric. `tokens` / `per_run` keep the CLI's own abbreviated
 * rendering (`480.2k`, `1.2M`, `–`) rather than being parsed back to integers:
 * the abbreviation is lossy, so re-deriving a number would invent precision
 * the render never had. `per_run` is null on narrow terminals, where the CLI
 * drops that column entirely.
 */
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
  /**
   * True when the render carries the 2.1.208+ "Showing last-known usage as
   * of <time> …" marker — the CLI is replaying cached bars because the usage
   * endpoint was rate-limited or a refresh failed. The numbers still parse,
   * but they describe an earlier point in time; the runner must not record
   * them as fresh utilization.
   */
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
  /**
   * Ranked tables Claude shows beneath "What's contributing" — see notes on
   * `UsageRunData.skills` in `src/lib/api.ts` for shape details. `mcp_servers`
   * is rendered by enterprise/Console accounts (and any account using MCP
   * servers); its row names contain spaces (e.g. "claude.ai Atlassian").
   */
  skills: UsageTable;
  subagents: UsageTable;
  plugins: UsageTable;
  mcp_servers: UsageTable;
  /**
   * The Loops breakdown (Claude Code 2.1.243+), rendered after `mcp_servers`
   * and before the tables footer. Empty on any CLI that doesn't draw it and
   * on accounts with no `/loop` history — the CLI omits the whole section
   * rather than drawing an empty one.
   */
  loops: UsageLoopsTable;
}


export type ParseResult =
  | { ok: true; data: UsageData }
  | { ok: false; reason: string };

// Section headers in the real TUI are indented (~2 spaces). The CLI also
// emits a row of tab labels (`Status   Config   Usage   Stats`) above the
// `Session` block, so we anchor on header text rather than column zero.
//
// Window headers are discovered rather than enumerated — see `findWindows`.
// The per-model weekly bars come from a generic `limits` array on the CLI
// side, so `(Sonnet only)` and `(Fable)` are two instances of an open set.
const SECTION_HEADERS = {
  session: /^[ \t]*Session\s*$/m,
  current_session: /^[ \t]*Current session\s*$/m,
  contributing: /^[ \t]*What's contributing to your limits usage\?\s*$/m,
  skills_table: /^[ \t]*Skills\s+% of usage\s*$/m,
  subagents_table: /^[ \t]*Subagents\s+% of usage\s*$/m,
  plugins_table: /^[ \t]*Plugins\s+% of usage\s*$/m,
  mcp_table: /^[ \t]*MCP servers\s+% of usage\s*$/m,
  // 2.1.243's Loops breakdown. Not a "% of usage" table — its columns are
  // `Loops | every | runs | tokens | per run | last run` — but it renders
  // between `MCP servers` and the footer, so it MUST be a boundary for the
  // table above it. Without that, the last ranked table's slice ran through
  // the Loops block and adopted its `… N more` line as its own `more_count`.
  loops_table: /^[ \t]*Loops\s+every\s+runs\s+tokens\b/m,
  // Footer hint Claude prints after the tables ("d to day · w to week").
  // Used as a hard end-boundary for the last table.
  tables_footer: /^[ \t]*d to day\b/m,
};

/**
 * Matches any rate-limit window header line, capturing the parenthesised
 * model name for the weekly bars. One regex rather than a fixed list so a
 * window the CLI adds later is *discovered* instead of dropped — the failure
 * mode that hid `Current week (Fable)` behind a Sonnet-only pattern.
 */
const WINDOW_HEADER = /^[ \t]*(Current session|Current week \(([^)]*)\))[ \t]*$/gm;
/** Same pattern, non-global, for use as a `sliceSection` end boundary. */
const ANY_WINDOW_HEADER = /^[ \t]*(?:Current session|Current week \([^)]*\))[ \t]*$/m;

/** `Sonnet only` → `week_sonnet`, `Fable` → `week_fable`, `all models` → `week_all_models`. */
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

/**
 * Window labels seen in the wild. Not a validation gate — an unknown label
 * still parses and still flows to storage — only the set that does NOT earn a
 * drift warning.
 */
const KNOWN_WINDOW_LABELS = new Set([
  'current_session',
  'week_all_models',
  'week_sonnet',
  'week_opus',
  'week_fable',
  'week_haiku',
]);

/**
 * Window label → the `rate_limit_type` stored by `rate-limits.ts`.
 *
 * Lives here, beside the labels it maps, so a newly discovered window gets a
 * rate-limit type without a second edit somewhere else. `humanType` and
 * `shouldNotify` in rate-limits.ts already degrade gracefully for a
 * `seven_day_*` value they have never seen.
 */
export function rateLimitTypeForWindow(label: string): string {
  if (label === 'current_session') return 'five_hour';
  if (label === 'week_all_models') return 'seven_day';
  if (label.startsWith('week_')) return `seven_day_${label.slice('week_'.length)}`;
  return label;
}

interface FoundWindow { label: string; bodyStart: number; headerStart: number }

/** All window headers in render order, with the offset each one's body starts at. */
function findWindows(text: string): FoundWindow[] {
  const out: FoundWindow[] = [];
  const re = new RegExp(WINDOW_HEADER.source, WINDOW_HEADER.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const label = windowLabelFor(m[1], m[2]);
    // A redrawn screen can repeat a header; first occurrence wins, matching
    // the previous first-match-wins behaviour of the fixed regexes.
    if (out.some((w) => w.label === label)) continue;
    out.push({ label, headerStart: m.index, bodyStart: m.index + m[0].length });
  }
  return out;
}

/**
 * A window's body runs to the next window header or to the contributing
 * section, whichever comes first. Bounding on "the next header of any kind"
 * is what keeps a trailing bar — the 2.1.236 `Usage credits` row, say — from
 * donating its `Resets` line to the window above it.
 */
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

// 2.1.208+ rate-limited / refresh-failed render marker. Both observed
// variants share the prefix:
//   "Showing last-known usage as of <time> (rate limited — try again in a moment)"
//   "Showing last-known usage as of <time> (could not refresh)"
const STALE_MARKER = /^[ \t]*Showing last-known usage/m;

/**
 * Returns true when the captured TUI text appears to be a complete `/usage`
 * render. Used by the runner as a fast-path exit signal — no need to wait the
 * full quiet timeout if the buffer is already complete. Returns false (keep
 * waiting) if a section is missing or still in mid-render.
 */
export function isUsageOutputComplete(input: string): boolean {
  const result = parseUsageOutput(input);
  if (!result.ok) return false;

  // Window-less (enterprise / Console) shape: these accounts have no
  // subscription rate-limit windows, so the TUI never renders the
  // "Current session" / "Current week" headers — it shows a persistent
  // "Loading usage data…" placeholder instead, then the contributing
  // section + ranked tables. Detect the absence of ALL window headers and
  // treat the render as complete once the tables footer ("d to day · w to
  // week") prints — that footer is the last thing drawn, so its presence
  // means the async local-session scan finished. If the footer never shows
  // (e.g. no local sessions to scan) the runner's quiet-timeout grace still
  // snapshots correctly; this is purely a fast-path. Ordering protects the
  // MAX path: windows render ABOVE the tables, so a MAX render that's far
  // enough along to show the footer already has its window headers and
  // takes the branch below.
  const text = input.replace(/\r\n/g, '\n');
  if (!ANY_WINDOW_HEADER.test(text)) {
    return SECTION_HEADERS.tables_footer.test(text);
  }

  // The two windows every subscription render has must have parsed, and every
  // window that DID parse must look settled. Per-model weekly bars are not
  // required by name: the set is open (`(Sonnet only)`, `(Fable)`, …), and
  // demanding a specific one is what left the fast path permanently disabled
  // for accounts whose weekly bar is not Sonnet.
  //
  // The contributing header renders BELOW every window, so its presence is
  // what says "the window list is finished" rather than "mid-paint". That
  // replaces the old rule of demanding a Sonnet bar by name, which could not
  // tell "Sonnet hasn't loaded yet" from "this account has no Sonnet bar" —
  // and so left the fast path permanently off for accounts whose per-model
  // bar is `(Fable)`.
  //
  // A non-empty Resets line is required EXCEPT for 0%-used windows — observed
  // in Claude Code 2.1.148: at 0% the TUI renders the header + bar but omits
  // the Resets line entirely (nothing to reset to). Without the carve-out the
  // fast path would never fire for that common case.
  for (const label of ['current_session', 'week_all_models']) {
    if (!result.data.windows.some((w) => w.label === label)) return false;
  }
  if (!SECTION_HEADERS.contributing.test(text)) return false;
  for (const w of result.data.windows) {
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

  // Windows: a matched header should be followed by a `% used` line. A header
  // without one means the usage-bar phrasing drifted.
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

  // An unrecognised weekly window is not an error — the CLI's per-model bars
  // are an open set and a new one should flow straight through. But it IS the
  // moment to look, because this is also what a mangled header would produce,
  // and a junk label becomes a junk `seven_day_*` rate-limit type downstream.
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

  // A valid render has at least one rate-limit window (subscription
  // accounts: MAX/Pro) OR the "What's contributing" section (enterprise /
  // Console accounts, which expose no per-window rate limits and render only
  // the contributing breakdown + ranked tables). Requiring one of the two
  // keeps the auth-error / mid-load garbage cases failing — those have
  // neither — while letting the window-less enterprise shape through.
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

/**
 * Parses the `/usage` Loops breakdown (Claude Code 2.1.243+):
 *
 *   Loops            every    runs   tokens   per run   last run
 *   check the deploy 5m       12     480.2k   40.0k     2h ago
 *   … 4 more
 *
 * Unlike the ranked tables, no column here has a fixed lexical shape: `every`
 * is a cron description (`5m`, `dynamic`, `?`, `at 09:30`, or prose from the
 * CLI's cron humaniser) and `last run` is a relative time. What IS reliable is
 * the layout — the CLI draws each cell in a padded fixed-width box, so columns
 * are separated by two or more spaces while spaces INSIDE a cell are single.
 * So we split on runs of whitespace and anchor on `runs`, the only column that
 * is always a bare integer (`every` never is).
 *
 * Anchoring rather than counting fields is what makes the narrow render work:
 * the CLI drops the `per run` column when the terminal is too small, and a
 * positional parse would then read `last run` as `per run`.
 */
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
    // Need at least prompt + every + runs + tokens.
    if (fields.length < 4) continue;
    const runsIdx = fields.findIndex((f, i) => i >= 1 && /^\d+$/.test(f));
    // `runsIdx < 2` means no `every` cell resolved — a prompt long enough to
    // fill its column swallows the gap after it. Skip that row rather than
    // shifting every later column by one.
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
  // Bound the slice to the first ranked-table header / tables footer so the
  // enterprise shape (which renders tables directly below the contributing
  // entries, with no intervening window block) doesn't pull table rows into
  // the contributing scan. Table rows are "name N%" (name-first) and don't
  // match the percent-headline test anyway, but bounding keeps the slice
  // honest and cheap. MAX renders without tables slice to end-of-text as
  // before.
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
