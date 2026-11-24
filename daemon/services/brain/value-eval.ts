/**
 * Is the Brain worth what it costs? The pure half of the answer.
 *
 * Three measurements used to be run by hand, each once, and each left its
 * numbers in a chat or a `/tmp` file: the invocation rate (how many real
 * sessions call `brain_search` at all), the spend (what indexing and curation
 * cost), and an LLM-judge pass (did a search actually help the session that
 * made it). None could be repeated the same way twice, so none could be
 * compared. This module fixes the definitions; `scripts/brain-eval.ts` reads
 * the transcripts and databases and stores each run for later comparison.
 *
 * Definitions that are load-bearing — each one corrupted an earlier figure:
 *
 * - **OmniFex's own scratch sessions are not sessions.** Summaries and Brain
 *   indexing run `claude -p` in `omnifex-summary-scratch`, outnumber human
 *   sessions, and never search. They are dropped from every denominator.
 * - **A session's date is its first record's timestamp**, not file mtime,
 *   which catches old sessions resumed inside the window.
 * - **Searches are counted from transcripts, money from `session_cost_daily`.**
 *   That table is what the Cost Report reads; `brain_spend` rides alongside as
 *   the audit cross-check, never summed with it.
 */

/** OmniFex's internal one-shot runs share this cwd basename. */
const SCRATCH_DIR_NAME = 'omnifex-summary-scratch';

const TOOL_PREFIX = 'mcp__omnifex-brain__brain_';
const CODE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** A session needs this many tool uses before a missing search means anything. */
export const SUBSTANTIVE_TOOL_USES = 20;

/** How much of the prompt and follow-up the judge gets to see per search. */
const PROMPT_EXCERPT = 1_000;
const RESULT_EXCERPT = 2_000;
const AFTER_EXCERPT = 3_000;
const AFTER_MAX_EVENTS = 14;

export type BrainTool = 'search' | 'read' | 'remember';

export interface BrainCall {
  tool: BrainTool;
  toolUseId: string;
  /** Position among ALL tool uses in the transcript — chains depend on gaps. */
  ordinal: number;
  query: string | null;
  /** Note paths a search returned, best first. Empty for reads/remembers. */
  results: string[];
  /** Size of the result the model had to read — its context cost. */
  resultChars: number;
  /** The head of that result, so the judge can tell a stale note from a good one. */
  resultExcerpt: string;
  /** The last user prompt before the call: what the session was trying to do. */
  promptBefore: string;
  /** What the model said and did next, condensed, for the judge. */
  after: string;
}

export interface TranscriptSummary {
  startedAt: string | null;
  cwd: string | null;
  toolUses: number;
  wroteCode: boolean;
  calls: BrainCall[];
}

export interface SessionSummary extends TranscriptSummary {
  sessionId: string;
}

export interface EvalWindow {
  /** Local dates, YYYY-MM-DD, both inclusive. */
  since: string;
  until: string;
}

export interface SpendRow {
  date: string;
  /** `session_cost_daily.internal_kind`: `brain-index` or `brain-curation`. */
  kind: string;
  usd: number;
}

export const VERDICTS = ['helped', 'confirmed', 'neutral', 'wasted', 'misled'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const VALUE_KINDS = ['continuity', 'code-knowledge', 'none'] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

export interface JudgeVerdict {
  caseId: string;
  verdict: Verdict;
  /** What kind of knowledge made the difference, if any. */
  value: ValueKind;
  /** A quote from the transcript backing the verdict. */
  evidence: string;
}

export interface JudgeTally {
  judged: number;
  helped: number;
  confirmed: number;
  neutral: number;
  wasted: number;
  misled: number;
  helpedRate: number | null;
  byValue: Record<string, number>;
  /** Window spend over the searches the sample says helped. */
  usdPerHelpedSearch: number | null;
}

export interface RetrievalScore {
  cases: number;
  /** Null below the minimum case count — a score off three cases is noise. */
  recallAt5: number | null;
  mrr: number | null;
}

export interface AccountMetrics {
  account: string;
  sessions: {
    total: number;
    withSearch: number;
    invocationRate: number | null;
    substantive: number;
    substantiveWithSearch: number;
    substantiveInvocationRate: number | null;
  };
  calls: {
    search: number;
    read: number;
    remember: number;
    emptySearches: number;
    emptyRate: number | null;
    /** chars / 4 — an estimate, labelled as one. */
    searchResultTokens: number;
  };
  spend: {
    indexUsd: number;
    curationUsd: number;
    totalUsd: number;
    /** `brain_spend` over the same window; should sit close to `totalUsd`. */
    ledgerUsd: number;
    monthlyUsd: number;
    perSearchUsd: number | null;
    perSearchingSessionUsd: number | null;
  };
  vault?: { notes: number; bytes: number };
  retrieval?: RetrievalScore;
  judge?: JudgeTally;
}

export interface RunMetrics {
  runId: string;
  createdAt: string;
  gitCommit: string | null;
  window: EvalWindow;
  accounts: AccountMetrics[];
}

// ── transcript parsing ────────────────────────────────────────────────────

/** `## <path>.md (<Type>)` — a full-body hit. Note bodies' own headings never end in `.md (X)`. */
const HIT_HEADING = /^## (\S.*?\.md) \([A-Za-z]+\)$/gm;
/** `- <path>.md (<Type>): snippet` — a listed hit under "Also matched". */
const LISTED_HIT = /^- (\S.*?\.md) \([A-Za-z]+\):/gm;

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof (b as { text?: unknown })?.text === 'string' ? (b as { text: string }).text : ''))
    .join('\n');
}

/**
 * The note paths a `brain_search` returned, best first.
 *
 * The tool replies in markdown now; before that it replied with a JSON array.
 * Old transcripts carry the JSON form, so both are read.
 */
export function parseSearchResultPaths(content: unknown): string[] {
  const text = contentText(content);
  if (text.trimStart().startsWith('[')) {
    try {
      const hits = JSON.parse(text) as { notePath?: unknown }[];
      if (Array.isArray(hits)) {
        return hits.map((h) => h.notePath).filter((p): p is string => typeof p === 'string');
      }
    } catch {
      // Not JSON after all — fall through to the markdown form.
    }
  }
  const full = [...text.matchAll(HIT_HEADING)].map((m) => m[1]);
  const listedAt = text.indexOf('\nAlso matched');
  const listed = listedAt === -1 ? [] : [...text.slice(listedAt).matchAll(LISTED_HIT)].map((m) => m[1]);
  return [...full, ...listed];
}

export function isInternalCwd(cwd: string | null): boolean {
  if (!cwd) return false;
  return cwd.replace(/\/+$/, '').split('/').pop() === SCRATCH_DIR_NAME;
}

type Event =
  | { kind: 'prompt'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'use'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'result'; id: string; content: unknown };

function asRecord(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === 'object' ? (x as Record<string, unknown>) : null;
}

function eventsOf(records: readonly unknown[]): Event[] {
  const events: Event[] = [];
  for (const raw of records) {
    const rec = asRecord(raw);
    const message = asRecord(rec?.message);
    if (!message) continue;
    const content = message.content;
    if (typeof content === 'string') {
      if (message.role === 'user') events.push({ kind: 'prompt', text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const userText: string[] = [];
    for (const b of content) {
      const block = asRecord(b);
      if (!block) continue;
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        events.push({ kind: 'use', id: block.id, name: block.name, input: asRecord(block.input) ?? {} });
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        events.push({ kind: 'result', id: block.tool_use_id, content: block.content });
      } else if (block.type === 'text' && typeof block.text === 'string') {
        if (message.role === 'user') userText.push(block.text);
        else events.push({ kind: 'text', text: block.text });
      }
    }
    if (userText.length > 0) events.push({ kind: 'prompt', text: userText.join('\n') });
  }
  return events;
}

function brainTool(name: string): BrainTool | null {
  if (!name.startsWith(TOOL_PREFIX)) return null;
  const tool = name.slice(TOOL_PREFIX.length);
  return tool === 'search' || tool === 'read' || tool === 'remember' ? tool : null;
}

/** One line per follow-up action: enough to judge, short enough to read 40 of. */
function describeUse(name: string, input: Record<string, unknown>): string {
  const arg = ['file_path', 'path', 'command', 'query', 'pattern', 'description']
    .map((k) => input[k])
    .find((v): v is string => typeof v === 'string');
  return `[${name}${arg ? ` ${arg.slice(0, 160)}` : ''}]`;
}

function followUp(events: readonly Event[], from: number): string {
  const out: string[] = [];
  let len = 0;
  for (let i = from; i < events.length && out.length < AFTER_MAX_EVENTS && len < AFTER_EXCERPT; i++) {
    const e = events[i];
    const line =
      e.kind === 'text' ? e.text : e.kind === 'use' ? describeUse(e.name, e.input) : e.kind === 'prompt' ? `USER: ${e.text}` : '';
    if (!line) continue;
    out.push(line);
    len += line.length;
  }
  return out.join('\n').slice(0, AFTER_EXCERPT);
}

/** One transcript file (a session or one of its subagents), reduced to what the eval needs. */
export function summarizeTranscript(records: readonly unknown[]): TranscriptSummary {
  let startedAt: string | null = null;
  let cwd: string | null = null;
  for (const raw of records) {
    const rec = asRecord(raw);
    if (!rec) continue;
    if (startedAt === null && typeof rec.timestamp === 'string') startedAt = rec.timestamp;
    if (cwd === null && typeof rec.cwd === 'string') cwd = rec.cwd;
    if (startedAt !== null && cwd !== null) break;
  }

  const events = eventsOf(records);
  const resultAt = new Map<string, number>();
  events.forEach((e, i) => {
    // First copy wins: the CLI re-appends records with the same ids around compaction.
    if (e.kind === 'result' && !resultAt.has(e.id)) resultAt.set(e.id, i);
  });

  let toolUses = 0;
  let wroteCode = false;
  let lastPrompt = '';
  const calls: BrainCall[] = [];
  const seen = new Set<string>();
  events.forEach((e, i) => {
    if (e.kind === 'prompt') lastPrompt = e.text;
    if (e.kind !== 'use' || seen.has(e.id)) return;
    seen.add(e.id);
    const ordinal = toolUses++;
    if (CODE_TOOLS.has(e.name)) wroteCode = true;
    const tool = brainTool(e.name);
    if (!tool) return;
    const at = resultAt.get(e.id);
    const content = at === undefined ? undefined : (events[at] as { content: unknown }).content;
    calls.push({
      tool,
      toolUseId: e.id,
      ordinal,
      query: typeof e.input.query === 'string' ? e.input.query : null,
      results: tool === 'search' ? parseSearchResultPaths(content) : [],
      resultChars: contentText(content).length,
      resultExcerpt: contentText(content).slice(0, RESULT_EXCERPT),
      promptBefore: lastPrompt.slice(0, PROMPT_EXCERPT),
      after: followUp(events, (at ?? i) + 1),
    });
  });

  return { startedAt, cwd, toolUses, wroteCode, calls };
}

// ── aggregation ───────────────────────────────────────────────────────────

/** The user's own calendar date for an instant — what every window is in. */
export function localDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function inWindow(date: string, w: EvalWindow): boolean {
  return date >= w.since && date <= w.until;
}

export function windowDays(w: EvalWindow): number {
  const ms = Date.parse(`${w.until}T00:00:00Z`) - Date.parse(`${w.since}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

export function aggregateAccount(input: {
  account: string;
  window: EvalWindow;
  sessions: readonly SessionSummary[];
  spend: readonly SpendRow[];
  ledgerUsd: number;
}): AccountMetrics {
  const { window } = input;
  const human = input.sessions.filter(
    (s) => s.startedAt !== null && !isInternalCwd(s.cwd) && inWindow(localDate(s.startedAt), window),
  );
  const searched = (s: SessionSummary) => s.calls.some((c) => c.tool === 'search');
  const substantive = human.filter((s) => s.toolUses >= SUBSTANTIVE_TOOL_USES);
  const calls = human.flatMap((s) => s.calls);
  const searches = calls.filter((c) => c.tool === 'search');
  const emptySearches = searches.filter((c) => c.results.length === 0).length;
  const withSearch = human.filter(searched).length;

  const spend = input.spend.filter((r) => inWindow(r.date, window));
  const sum = (kind: string) => spend.filter((r) => r.kind === kind).reduce((a, r) => a + r.usd, 0);
  const indexUsd = sum('brain-index');
  const curationUsd = sum('brain-curation');
  const totalUsd = indexUsd + curationUsd;

  return {
    account: input.account,
    sessions: {
      total: human.length,
      withSearch,
      invocationRate: ratio(withSearch, human.length),
      substantive: substantive.length,
      substantiveWithSearch: substantive.filter(searched).length,
      substantiveInvocationRate: ratio(substantive.filter(searched).length, substantive.length),
    },
    calls: {
      search: searches.length,
      read: calls.filter((c) => c.tool === 'read').length,
      remember: calls.filter((c) => c.tool === 'remember').length,
      emptySearches,
      emptyRate: ratio(emptySearches, searches.length),
      searchResultTokens: Math.round(searches.reduce((a, c) => a + c.resultChars, 0) / 4),
    },
    spend: {
      indexUsd,
      curationUsd,
      totalUsd,
      ledgerUsd: input.ledgerUsd,
      monthlyUsd: (totalUsd * 30) / windowDays(window),
      perSearchUsd: ratio(totalUsd, searches.length),
      perSearchingSessionUsd: ratio(totalUsd, withSearch),
    },
  };
}

// ── judging ───────────────────────────────────────────────────────────────

/** FNV-1a: a stable, dependency-free ordering key. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The searches to judge when there are more than the judge can read.
 *
 * Ordered by a hash of the tool-use id, so the same window yields the same
 * sample on every run, and a later run's sample is not biased toward the
 * most recent sessions.
 */
export function judgeSample<T extends { toolUseId: string }>(cases: readonly T[], cap: number): T[] {
  return [...cases].sort((a, b) => hash(a.toolUseId) - hash(b.toolUseId)).slice(0, cap);
}

export function tallyVerdicts(
  verdicts: readonly JudgeVerdict[],
  ctx: { totalUsd: number; searches: number },
): JudgeTally {
  const count = (v: Verdict) => verdicts.filter((x) => x.verdict === v).length;
  const byValue: Record<string, number> = {};
  for (const v of verdicts) {
    if (!(VERDICTS as readonly string[]).includes(v.verdict)) {
      throw new Error(`case ${v.caseId}: verdict "${v.verdict}" is not one of ${VERDICTS.join(', ')}`);
    }
    if (!(VALUE_KINDS as readonly string[]).includes(v.value)) {
      throw new Error(`case ${v.caseId}: value "${v.value}" is not one of ${VALUE_KINDS.join(', ')}`);
    }
    byValue[v.value] = (byValue[v.value] ?? 0) + 1;
  }
  const helped = count('helped');
  const helpedRate = ratio(helped, verdicts.length);
  const helpedSearches = helpedRate === null ? 0 : helpedRate * ctx.searches;
  return {
    judged: verdicts.length,
    helped,
    confirmed: count('confirmed'),
    neutral: count('neutral'),
    wasted: count('wasted'),
    misled: count('misled'),
    helpedRate,
    byValue,
    usdPerHelpedSearch: helpedSearches === 0 ? null : ctx.totalUsd / helpedSearches,
  };
}

// ── comparison ────────────────────────────────────────────────────────────

const COMPARED: readonly [string, (a: AccountMetrics) => number | null | undefined][] = [
  ['sessions', (a) => a.sessions?.total],
  ['invocation rate', (a) => a.sessions?.invocationRate],
  ['substantive invocation rate', (a) => a.sessions?.substantiveInvocationRate],
  ['searches', (a) => a.calls?.search],
  ['empty search rate', (a) => a.calls?.emptyRate],
  ['search result tokens', (a) => a.calls?.searchResultTokens],
  ['monthly $', (a) => a.spend?.monthlyUsd],
  ['$ per search', (a) => a.spend?.perSearchUsd],
  ['helped rate', (a) => a.judge?.helpedRate],
  ['misled', (a) => a.judge?.misled],
  ['$ per helped search', (a) => a.judge?.usdPerHelpedSearch],
  ['recall@5', (a) => a.retrieval?.recallAt5],
  ['notes (when measured)', (a) => a.vault?.notes],
];

export interface ComparisonRow {
  account: string;
  metric: string;
  /** One per run, oldest first; null where a run lacks the metric. */
  values: (number | null)[];
}

export function compareRuns(runs: readonly RunMetrics[]): ComparisonRow[] {
  const ordered = [...runs].sort((a, b) => a.runId.localeCompare(b.runId));
  const accounts = [...new Set(ordered.flatMap((r) => r.accounts.map((a) => a.account)))];
  return accounts.flatMap((account) =>
    COMPARED.map(([metric, get]) => ({
      account,
      metric,
      values: ordered.map((r) => {
        const a = r.accounts.find((x) => x.account === account);
        return (a && get(a)) ?? null;
      }),
    })),
  );
}
