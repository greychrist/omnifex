/**
 * Measure the Brain's retrieval quality against labels mined from real usage.
 *
 * Ground truth comes from the model's own reformulation chains: when a
 * brain_search is immediately followed by another brain_search, the first
 * query failed and the note the final query surfaced is what it should have
 * found. See electron/services/brain/retrieval-eval.ts for the reasoning.
 *
 * Usage:
 *   npm rebuild better-sqlite3          # once, if the app has been run since
 *   node --experimental-strip-types --import ./scripts/lib/register-ts.mjs \
 *        scripts/brain-retrieval-eval.ts [--verbose]
 *   npm run rebuild:electron            # before launching OmniFex again
 *
 * Reads only: the accounts' session transcripts and each vault's FTS index,
 * both opened read-only. Writes nothing.
 */
import BetterSqlite3 from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  chainsToCases,
  groupChains,
  rankOf,
  score,
  type EvalCase,
  type SearchCall,
} from '../electron/services/brain/retrieval-eval.ts';
// The real shipped search path — imported rather than reimplemented so the
// bm25 weights cannot drift between what ships and what gets measured.
import { openVaultIndexReadOnly } from '../electron/services/brain/search.ts';

const APP_DB = join(
  homedir(),
  'Library/Application Support/OmniFex/greychrist.db',
);
/** Deep enough to score recall@20 and still see near-misses beyond it. */
const REPLAY_LIMIT = 50;
const BRAIN_SEARCH = 'mcp__omnifex-brain__brain_search';

/**
 * Below this many cases, print the counts and refuse to print a scoreboard.
 *
 * Reporting recall to one decimal place off three cases is how this whole
 * exercise started: "22 previously empty queries now return hits" read as a
 * result when it was a sample too small and too indirect to support one. A
 * benchmark that will not quote itself when it cannot is worth more than one
 * that always produces a number.
 */
const MIN_CASES = 10;

/**
 * Transcripts touched this recently are treated as still running.
 *
 * A live session's final chain is truncated by definition — its next search
 * has not happened yet — so mining it invents reformulations that were really
 * just the last thing the model did before now.
 */
const IN_FLIGHT_MS = 60 * 60 * 1000;

interface Account {
  id: number;
  name: string;
  configDir: string;
  vault: string;
}

interface Case extends EvalCase {
  account: string;
  vault: string;
}

/** Accounts that have a Brain vault configured, from OmniFex's own database. */
function readAccounts(): Account[] {
  if (!existsSync(APP_DB)) {
    throw new Error(`OmniFex database not found at ${APP_DB}`);
  }
  const db = new BetterSqlite3(APP_DB, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT a.id, a.name, a.config_dir AS configDir, s.value AS vault
           FROM accounts a
           JOIN app_settings s ON s.key = 'brain.vault.' || a.id`,
      )
      .all() as Account[];
    return rows.filter((r) => existsSync(r.vault));
  } finally {
    db.close();
  }
}

/** Every `*.jsonl` transcript under an account's `projects/` tree. */
function transcripts(configDir: string): string[] {
  const root = join(configDir, 'projects');
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const sub = join(root, dir.name);
    for (const f of readdirSync(sub)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = join(sub, f);
      if (Date.now() - statSync(full).mtimeMs < IN_FLIGHT_MS) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * The `notePath`s a brain_search returned, best-ranked first.
 *
 * The MCP result arrives as a text block holding a JSON array. A tool error
 * (no index, bad query) arrives as prose, which parses to nothing and is
 * correctly treated as an empty result set.
 */
function resultPaths(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  for (const block of content) {
    const text = (block as { type?: string; text?: string }).text;
    if (typeof text !== 'string') continue;
    try {
      const hits = JSON.parse(text) as { notePath?: string }[];
      if (!Array.isArray(hits)) continue;
      return hits.map((h) => h.notePath).filter((p): p is string => typeof p === 'string');
    } catch {
      // Prose, not JSON — an error string or a truncated block. No hits.
    }
  }
  return [];
}

/** Recover this session's brain_search calls, ordered by tool-use position. */
function searchCallsIn(file: string): SearchCall[] {
  let lines: Record<string, unknown>[];
  try {
    lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return []; // A partially written transcript is skipped, not fatal.
  }

  // Ordinal counts EVERY tool use, so a gap between two searches means some
  // other tool ran in between — the adjacency signal chains depend on.
  let ordinal = 0;
  const pending = new Map<string, { ordinal: number; query: string }>();
  const results = new Map<string, string[]>();

  for (const line of lines) {
    const content = (line.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === 'tool_use') {
        if (block.name === BRAIN_SEARCH) {
          const query = (block.input as { query?: string } | undefined)?.query;
          if (typeof query === 'string') {
            pending.set(block.id as string, { ordinal, query });
          }
        }
        ordinal++;
      } else if (block.type === 'tool_result') {
        const id = block.tool_use_id as string;
        if (pending.has(id)) results.set(id, resultPaths(block.content));
      }
    }
  }

  return [...pending.entries()].map(([id, { ordinal: o, query }]) => ({
    ordinal: o,
    query,
    results: results.get(id) ?? [],
  }));
}

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

function main(): void {
  const verbose = process.argv.includes('--verbose');
  const accounts = readAccounts();
  if (accounts.length === 0) throw new Error('no accounts with a Brain vault');

  const cases: Case[] = [];
  let totalSearches = 0;
  let totalChains = 0;

  for (const account of accounts) {
    for (const file of transcripts(account.configDir)) {
      const calls = searchCallsIn(file);
      if (calls.length === 0) continue;
      totalSearches += calls.length;
      const chains = groupChains(calls);
      totalChains += chains.filter((c) => c.length > 1).length;
      for (const c of chainsToCases(chains)) {
        cases.push({ ...c, account: account.name, vault: account.vault });
      }
    }
  }

  console.log(`\nMined ${totalSearches} brain_search calls across ${accounts.length} accounts`);
  console.log(`  reformulation chains (2+ searches): ${totalChains}`);
  console.log(`  usable labelled cases:              ${cases.length}\n`);
  if (cases.length === 0) return;

  const byVault = new Map<string, Case[]>();
  for (const c of cases) {
    const list = byVault.get(c.vault) ?? [];
    list.push(c);
    byVault.set(c.vault, list);
  }

  const allRanks: (number | null)[] = [];
  const stale: Case[] = [];
  const rows: { c: Case; rank: number | null }[] = [];

  for (const [vault, vaultCases] of byVault) {
    const dbPath = join(vault, '.omnifex', 'index.db');
    if (!existsSync(dbPath)) {
      console.log(`  (no index at ${dbPath} — skipping ${vaultCases.length} cases)`);
      continue;
    }
    const index = openVaultIndexReadOnly(dbPath);
    const present = new Set(
      (
        new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true })
          .prepare('SELECT note_path FROM brain_fts')
          .all() as { note_path: string }[]
      ).map((r) => r.note_path),
    );
    try {
      for (const c of vaultCases) {
        // A target that has since been renamed or curated away is not a
        // retrieval failure, so it is reported separately and left unscored.
        if (!present.has(c.target)) {
          stale.push(c);
          continue;
        }
        const hits = index.search(c.query, { limit: REPLAY_LIMIT });
        const rank = rankOf(
          c.target,
          hits.map((h) => h.notePath),
        );
        allRanks.push(rank);
        rows.push({ c, rank });
      }
    } finally {
      index.close();
    }
  }

  if (allRanks.length < MIN_CASES) {
    console.log(
      `Not enough labelled cases to report a score (${allRanks.length} of ${MIN_CASES} needed).`,
    );
    console.log(
      'The label source is real reformulation chains, so the set grows only as',
    );
    console.log('the Brain gets used. Re-run once invocation has picked up.\n');
    if (rows.length > 0) {
      console.log('Cases so far:');
      for (const { c, rank } of rows) {
        console.log(`  [${rank === null ? 'miss' : `#${rank}`}] ${c.query}  →  ${c.target}`);
      }
      console.log();
    }
    return;
  }

  const s = score(allRanks);
  console.log('BASELINE — current FTS5 index');
  console.log('─'.repeat(52));
  console.log(`  cases scored   ${s.n}`);
  console.log(`  recall@1       ${pct(s.recallAt1)}`);
  console.log(`  recall@5       ${pct(s.recallAt5)}`);
  console.log(`  recall@20      ${pct(s.recallAt20)}`);
  console.log(`  MRR            ${s.mrr.toFixed(3)}`);
  if (stale.length > 0) {
    console.log(`  excluded       ${stale.length} (target note no longer in vault)`);
  }
  console.log();

  const misses = rows.filter((r) => r.rank === null || r.rank > 5);
  if (misses.length > 0) {
    console.log(`WORST CASES (target outside top 5) — ${misses.length}`);
    console.log('─'.repeat(52));
    for (const { c, rank } of misses) {
      console.log(`  [${rank === null ? 'miss' : `#${rank}`}] ${c.query}`);
      console.log(`         want: ${c.target}`);
      console.log(`         chain: ${c.chain.join('  →  ')}`);
    }
    console.log();
  }

  if (verbose) {
    console.log('ALL CASES');
    console.log('─'.repeat(52));
    for (const { c, rank } of rows) {
      console.log(
        `  ${(rank === null ? 'miss' : `#${rank}`).padEnd(5)} ${c.account.padEnd(9)} ${c.query}`,
      );
    }
  }
}

main();
