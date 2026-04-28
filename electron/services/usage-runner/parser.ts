export type UsageWindow = {
  label: 'current_session' | 'week_all_models' | 'week_sonnet';
  pct_used: number;
  resets_at_label: string;
};

export type UsageData = {
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
};

export type ParseResult =
  | { ok: true; data: UsageData }
  | { ok: false; reason: string };

// Section headers in the real TUI are indented (~2 spaces). The CLI also
// emits a row of tab labels (`Status   Config   Usage   Stats`) above the
// `Session` block, so we anchor on header text rather than column zero.
const SECTION_HEADERS = {
  session: /^[ \t]*Session\s*$/m,
  current_session: /^[ \t]*Current session\s*$/m,
  week_all_models: /^[ \t]*Current week \(all models\)\s*$/m,
  week_sonnet: /^[ \t]*Current week \(Sonnet only\)\s*$/m,
  contributing: /^[ \t]*What's contributing to your limits usage\?\s*$/m,
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
  // All three known windows must have parsed, with a non-empty resets line.
  // If a future CLI version emits more sections we still pass; if it emits
  // fewer (e.g. free-tier accounts that only show the session window), the
  // fast-path stays disabled and the runner falls back to the quiet timeout.
  const required: Array<UsageWindow['label']> = ['current_session', 'week_all_models', 'week_sonnet'];
  for (const label of required) {
    const w = result.data.windows.find((w) => w.label === label);
    if (!w) return false;
    if (!w.resets_at_label.trim()) return false;
  }
  return true;
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

  return {
    ok: true,
    data: { session, windows, contributing },
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
