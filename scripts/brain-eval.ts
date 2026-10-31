/**
 * Measure whether the Brain is worth what it costs, and keep the answer.
 *
 * Every run is stored under `<userData>/brain-evals/<runId>/` — beside
 * greychrist.db, outside the repo (which is public, and the runs quote real
 * session transcripts from both accounts) and outside /tmp (where the first
 * judge pass's verdicts were lost). `compare` reads every stored run.
 *
 * Usage (see .claude/skills/brain-eval/SKILL.md for the whole procedure):
 *   node --experimental-strip-types --import ./scripts/lib/register-ts.mjs \
 *        scripts/brain-eval.ts measure [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--judge-cap N]
 *   ... scripts/brain-eval.ts record <runDir>     # after the judge wrote verdicts-<account>.json
 *   ... scripts/brain-eval.ts compare
 *
 * Reads transcripts, greychrist.db and each vault's index, all read-only.
 * Writes only inside the run directory.
 */
import BetterSqlite3 from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  aggregateAccount,
  compareRuns,
  isInternalCwd,
  judgeSample,
  localDate,
  summarizeTranscript,
  tallyVerdicts,
  type AccountMetrics,
  type EvalWindow,
  type JudgeVerdict,
  type RetrievalScore,
  type RunMetrics,
  type SessionSummary,
  type SpendRow,
  type TranscriptSummary,
} from '../electron/services/brain/value-eval.ts';
import { chainsToCases, groupChains, rankOf, score } from '../electron/services/brain/retrieval-eval.ts';
// The shipped search path, so the bm25 weights cannot drift from what is measured.
import { openVaultIndexReadOnly } from '../electron/services/brain/search.ts';

const USER_DATA =
  process.env.OMNIFEX_USER_DATA_DIR ?? join(homedir(), 'Library/Application Support/OmniFex');
const APP_DB = join(USER_DATA, 'greychrist.db');
const EVALS_DIR = join(USER_DATA, 'brain-evals');

/** A transcript touched this recently may still be running; its last search has no follow-up yet. */
const IN_FLIGHT_MS = 60 * 60 * 1000;
/** Below this many labelled retrieval cases, report the count and no score. */
const MIN_RETRIEVAL_CASES = 10;
const REPLAY_LIMIT = 50;
const DEFAULT_JUDGE_CAP = 40;

interface Account {
  id: number;
  name: string;
  configDir: string;
  vault: string;
}

interface JudgeCase {
  caseId: string;
  sessionId: string;
  startedAt: string | null;
  project: string;
  query: string | null;
  results: string[];
  resultExcerpt: string;
  promptBefore: string;
  after: string;
}

// ── inputs ────────────────────────────────────────────────────────────────

function openAppDb(): BetterSqlite3.Database {
  if (!existsSync(APP_DB)) throw new Error(`OmniFex database not found at ${APP_DB}`);
  return new BetterSqlite3(APP_DB, { readonly: true, fileMustExist: true });
}

function readAccounts(db: BetterSqlite3.Database): Account[] {
  return (
    db
      .prepare(
        `SELECT a.id, a.name, a.config_dir AS configDir, s.value AS vault
           FROM accounts a JOIN app_settings s ON s.key = 'brain.vault.' || a.id
          ORDER BY a.id`,
      )
      .all() as Account[]
  ).filter((a) => existsSync(a.vault));
}

function readSpend(db: BetterSqlite3.Database, account: string): SpendRow[] {
  return db
    .prepare(
      `SELECT date, internal_kind AS kind, SUM(cost_usd) AS usd FROM session_cost_daily
        WHERE account_name = ? AND internal_kind IN ('brain-index', 'brain-curation')
        GROUP BY date, internal_kind`,
    )
    .all(account) as SpendRow[];
}

function readLedgerUsd(db: BetterSqlite3.Database, account: string, w: EvalWindow): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM brain_spend
        WHERE account_name = ? AND date BETWEEN ? AND ?`,
    )
    .get(account, w.since, w.until) as { usd: number };
  return row.usd;
}

function readJsonl(file: string): unknown[] {
  const out: unknown[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn final line in a live transcript — skip it.
    }
  }
  return out;
}

/** Every `*.jsonl` under a directory, at any depth (workflow subagents nest deeper). */
function jsonlUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => join(e.parentPath, e.name));
}

interface SessionWithFiles {
  session: SessionSummary;
  /** Per-file summaries: retrieval chains must not cross from a session into its subagent. */
  files: TranscriptSummary[];
}

/**
 * Each top-level `<uuid>.jsonl` is one session; its subagents' transcripts
 * under `<uuid>/subagents/` count toward it, since a search a subagent made
 * was made on that session's behalf.
 */
function readSessions(configDir: string): SessionWithFiles[] {
  const root = join(configDir, 'projects');
  if (!existsSync(root)) return [];
  const out: SessionWithFiles[] = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory() || project.name.includes('omnifex-summary-scratch')) continue;
    const dir = join(root, project.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const main = join(dir, f);
      if (Date.now() - statSync(main).mtimeMs < IN_FLIGHT_MS) continue;
      const sessionId = f.slice(0, -'.jsonl'.length);
      const top = summarizeTranscript(readJsonl(main));
      if (isInternalCwd(top.cwd)) continue;
      const subs = jsonlUnder(join(dir, sessionId, 'subagents')).map((p) => summarizeTranscript(readJsonl(p)));
      const files = [top, ...subs];
      out.push({
        files,
        session: {
          sessionId,
          startedAt: top.startedAt,
          cwd: top.cwd,
          toolUses: files.reduce((a, s) => a + s.toolUses, 0),
          wroteCode: files.some((s) => s.wroteCode),
          calls: files.flatMap((s) => s.calls),
        },
      });
    }
  }
  return out;
}

function vaultStats(vault: string): { notes: number; bytes: number } {
  let notes = 0;
  let bytes = 0;
  for (const e of readdirSync(vault, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const full = join(e.parentPath, e.name);
    if (full.includes('/.git/') || full.includes('/.omnifex/')) continue;
    notes++;
    bytes += statSync(full).size;
  }
  return { notes, bytes };
}

/** Replay mined reformulation chains against today's index; see retrieval-eval.ts. */
function retrievalScore(vault: string, files: readonly TranscriptSummary[]): RetrievalScore {
  const cases = files.flatMap((f) =>
    chainsToCases(
      groupChains(
        f.calls
          .filter((c) => c.tool === 'search' && c.query !== null)
          .map((c) => ({ ordinal: c.ordinal, query: c.query as string, results: c.results })),
      ),
    ),
  );
  const dbPath = join(vault, '.omnifex', 'index.db');
  if (cases.length === 0 || !existsSync(dbPath)) return { cases: cases.length, recallAt5: null, mrr: null };
  const index = openVaultIndexReadOnly(dbPath);
  try {
    const ranks = cases.map((c) =>
      rankOf(
        c.target,
        index.search(c.query, { limit: REPLAY_LIMIT }).map((h) => h.notePath),
      ),
    );
    if (ranks.length < MIN_RETRIEVAL_CASES) return { cases: ranks.length, recallAt5: null, mrr: null };
    const s = score(ranks);
    return { cases: s.n, recallAt5: s.recallAt5, mrr: s.mrr };
  } finally {
    index.close();
  }
}

// ── output ────────────────────────────────────────────────────────────────

const pct = (x: number | null | undefined) => (x == null ? '—' : `${(100 * x).toFixed(1)}%`);
const usd = (x: number | null | undefined) => (x == null ? '—' : `$${x.toFixed(2)}`);
const num = (x: number | null | undefined) => (x == null ? '—' : String(Math.round(x * 100) / 100));

function renderReport(run: RunMetrics): string {
  const lines = [
    `# Brain value eval — ${run.runId}`,
    '',
    `Window ${run.window.since} → ${run.window.until} · commit ${run.gitCommit ?? 'unknown'} · created ${run.createdAt}`,
    '',
  ];
  for (const a of run.accounts) {
    const j = a.judge;
    lines.push(
      `## ${a.account}`,
      '',
      '| Metric | Value |',
      '|---|---|',
      `| Human sessions | ${a.sessions.total} |`,
      `| Invocation rate (any search) | ${pct(a.sessions.invocationRate)} (${a.sessions.withSearch}) |`,
      `| Substantive sessions (≥20 tool uses) invocation | ${pct(a.sessions.substantiveInvocationRate)} (${a.sessions.substantiveWithSearch}/${a.sessions.substantive}) |`,
      `| Searches / reads / remembers | ${a.calls.search} / ${a.calls.read} / ${a.calls.remember} |`,
      `| Empty searches | ${pct(a.calls.emptyRate)} (${a.calls.emptySearches}) |`,
      `| Search result tokens (est.) | ${a.calls.searchResultTokens} |`,
      `| Spend: index + curation | ${usd(a.spend.indexUsd)} + ${usd(a.spend.curationUsd)} = ${usd(a.spend.totalUsd)} (ledger ${usd(a.spend.ledgerUsd)}) |`,
      `| Spend, 30-day rate | ${usd(a.spend.monthlyUsd)} |`,
      `| $ per search / per searching session | ${usd(a.spend.perSearchUsd)} / ${usd(a.spend.perSearchingSessionUsd)} |`,
      `| Vault | ${a.vault?.notes ?? '—'} notes, ${a.vault ? `${(a.vault.bytes / 1024).toFixed(0)} KB` : '—'} |`,
      `| Retrieval (reformulation chains) | ${a.retrieval?.cases ?? 0} cases, recall@5 ${pct(a.retrieval?.recallAt5)}, MRR ${num(a.retrieval?.mrr)} |`,
      j
        ? `| Judge (${j.judged} sampled) | helped ${j.helped}, confirmed ${j.confirmed}, neutral ${j.neutral}, wasted ${j.wasted}, misled ${j.misled} |`
        : '| Judge | not run |',
      j ? `| Helped rate / $ per helped search | ${pct(j.helpedRate)} / ${usd(j.usdPerHelpedSearch)} |` : '',
      j ? `| What helped | ${Object.entries(j.byValue).map(([k, v]) => `${k} ${v}`).join(', ')} |` : '',
      '',
    );
  }
  return lines.filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}

function gitCommit(): string | null {
  try {
    return execFileSync('/usr/bin/git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function defaultWindow(): EvalWindow {
  // The last 30 full days: today is partial, and a partial day skews the rate.
  const day = 86_400_000;
  return { since: localDate(new Date(Date.now() - 30 * day).toISOString()), until: localDate(new Date(Date.now() - day).toISOString()) };
}

// ── commands ──────────────────────────────────────────────────────────────

function measure(): void {
  const def = defaultWindow();
  const window: EvalWindow = { since: arg('--since') ?? def.since, until: arg('--until') ?? def.until };
  const cap = Number(arg('--judge-cap') ?? DEFAULT_JUDGE_CAP);
  const createdAt = new Date().toISOString();
  const runId = `${window.since}_${window.until}_${createdAt.slice(0, 16).replace(/[:]/g, '')}`;
  const runDir = join(EVALS_DIR, runId);
  mkdirSync(runDir, { recursive: true });

  const db = openAppDb();
  const accounts: AccountMetrics[] = [];
  try {
    for (const account of readAccounts(db)) {
      const all = readSessions(account.configDir);
      const inWindow = all.filter(
        ({ session: s }) =>
          s.startedAt !== null && localDate(s.startedAt) >= window.since && localDate(s.startedAt) <= window.until,
      );
      const metrics = aggregateAccount({
        account: account.name,
        window,
        sessions: inWindow.map((x) => x.session),
        spend: readSpend(db, account.name),
        ledgerUsd: readLedgerUsd(db, account.name, window),
      });
      metrics.vault = vaultStats(account.vault);
      metrics.retrieval = retrievalScore(account.vault, inWindow.flatMap((x) => x.files));
      accounts.push(metrics);

      const searches = inWindow.flatMap(({ session: s }) =>
        s.calls.filter((c) => c.tool === 'search').map((c) => ({ toolUseId: c.toolUseId, s, c })),
      );
      const sample = judgeSample(searches, cap).map(
        ({ s, c }): JudgeCase => ({
          caseId: c.toolUseId,
          sessionId: s.sessionId,
          startedAt: s.startedAt,
          project: basename(s.cwd ?? ''),
          query: c.query,
          results: c.results.slice(0, 8),
          resultExcerpt: c.resultExcerpt,
          promptBefore: c.promptBefore,
          after: c.after,
        }),
      );
      writeFileSync(join(runDir, `cases-${account.name}.json`), `${JSON.stringify(sample, null, 2)}\n`);
      console.log(`${account.name}: ${metrics.calls.search} searches, ${sample.length} sampled for judging`);
    }
  } finally {
    db.close();
  }

  const run: RunMetrics = { runId, createdAt, gitCommit: gitCommit(), window, accounts };
  writeFileSync(join(runDir, 'metrics.json'), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(runDir, 'report.md'), `${renderReport(run)}\n`);
  console.log(`\n${renderReport(run)}\n\nRun stored in ${runDir}`);
}

function record(runDir: string | undefined): void {
  if (!runDir || !existsSync(join(runDir, 'metrics.json'))) throw new Error('usage: record <runDir>');
  const run = JSON.parse(readFileSync(join(runDir, 'metrics.json'), 'utf8')) as RunMetrics;
  for (const a of run.accounts) {
    const file = join(runDir, `verdicts-${a.account}.json`);
    if (!existsSync(file)) {
      console.log(`${a.account}: no verdicts file, judge left unset`);
      continue;
    }
    const verdicts = JSON.parse(readFileSync(file, 'utf8')) as JudgeVerdict[];
    const cases = JSON.parse(readFileSync(join(runDir, `cases-${a.account}.json`), 'utf8')) as JudgeCase[];
    const ids = new Set(cases.map((c) => c.caseId));
    const judged = verdicts.map((v) => v.caseId);
    const twice = judged.filter((id, i) => judged.indexOf(id) !== i);
    if (twice.length > 0) throw new Error(`${a.account}: cases judged twice ${twice.join(', ')}`);
    const unknown = verdicts.filter((v) => !ids.has(v.caseId));
    if (unknown.length > 0) throw new Error(`${a.account}: verdicts for unknown cases ${unknown.map((v) => v.caseId).join(', ')}`);
    if (verdicts.length !== cases.length) {
      console.log(`${a.account}: ${verdicts.length} of ${cases.length} cases judged`);
    }
    a.judge = tallyVerdicts(verdicts, { totalUsd: a.spend.totalUsd, searches: a.calls.search });
  }
  writeFileSync(join(runDir, 'metrics.json'), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(runDir, 'report.md'), `${renderReport(run)}\n`);
  console.log(renderReport(run));
}

function compare(): void {
  const runs = existsSync(EVALS_DIR)
    ? readdirSync(EVALS_DIR)
        .map((d) => join(EVALS_DIR, d, 'metrics.json'))
        .filter((f) => existsSync(f))
        .map((f) => JSON.parse(readFileSync(f, 'utf8')) as RunMetrics)
    : [];
  if (runs.length === 0) throw new Error(`no stored runs in ${EVALS_DIR}`);
  runs.sort((a, b) => a.runId.localeCompare(b.runId));
  const rates = new Set(['invocation rate', 'substantive invocation rate', 'empty search rate', 'helped rate', 'recall@5']);
  const money = new Set(['monthly $', '$ per search', '$ per helped search']);
  const fmt = (metric: string, v: number | null) => (rates.has(metric) ? pct(v) : money.has(metric) ? usd(v) : num(v));
  const header = `| Account | Metric | ${runs.map((r) => `${r.window.since}→${r.window.until}`).join(' | ')} |`;
  const lines = [header, `|---|---|${runs.map(() => '---').join('|')}|`];
  for (const row of compareRuns(runs)) {
    lines.push(`| ${row.account} | ${row.metric} | ${row.values.map((v) => fmt(row.metric, v)).join(' | ')} |`);
  }
  console.log(lines.join('\n'));
}

const command = process.argv[2];
if (command === 'measure') measure();
else if (command === 'record') record(process.argv[3]);
else if (command === 'compare') compare();
else {
  console.error('usage: brain-eval.ts measure|record <runDir>|compare');
  process.exit(2);
}
