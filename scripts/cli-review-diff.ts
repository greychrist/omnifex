/**
 * The mechanical half of a Claude Code release review: diff two installed CLI
 * bundles, and check the newer one against what OmniFex itself knows.
 *
 *   npm run cli-review:diff -- <reviewedVersion> <installedVersion> [--full]
 *
 * The review prompt (`src/lib/cliReviewPrompt.ts`) used to carry these as
 * hand-typed `rg` one-liners. Each review re-typed them a little differently,
 * a regex quantifier over 255 silently matched nothing under BSD grep, and
 * nothing noticed when an anchor stopped matching — an empty set reads
 * exactly like "no change". Here every check has a test, and an extractor
 * that finds nothing says so (ANCHOR NOT FOUND, exit 2) instead of passing.
 *
 * Two directions, because each is blind to what the other catches:
 *
 *  - version to version — what moved in this range. Cheap, but it only ever
 *    sees the range: a gap an earlier review let through is invisible to it
 *    forever (PreModelSwitch / PostModelSwitch sat outside HOOK_EVENTS for
 *    sixty releases this way).
 *  - installed binary vs OmniFex — the record types, hook events, control
 *    subtypes and flags OmniFex depends on, read from the real modules and
 *    sources rather than from a copy kept here, so it cannot drift from them.
 *
 * Bundles are read from `~/.local/share/claude/versions/<version>` (override
 * with CLAUDE_VERSIONS_DIR, or pass a path instead of a version).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Extractor {
  name: string;
  extract(text: string): string[];
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function all(re: RegExp, text: string): string[] {
  return uniqueSorted([...text.matchAll(re)].map((m) => m[1]));
}

/**
 * Keys the CLI's JSONL merge-strategy map is known to hold. Several, so the
 * map is still found the day any one of them is retired.
 */
const MERGE_MAP_ANCHORS = ['atis-latch', 'custom-title', 'ai-title', 'last-prompt', 'file-history-snapshot'];

/**
 * The map from every record type the CLI writes into a session file to its
 * merge strategy, as `type=strategy`. Exactly four types are "transcript";
 * the rest are bookkeeping. Found by widening from a known key to the
 * enclosing brace-free object, accepted only if it holds `user:"transcript"`.
 * Keys that are valid identifiers come out of the minifier bare (`user:`,
 * `mode:`), hyphenated ones quoted (`"atis-latch":`) — read both.
 */
export function extractMergeMap(text: string): string[] {
  for (const anchor of MERGE_MAP_ANCHORS) {
    const needle = `"${anchor}":"`;
    let at = text.indexOf(needle);
    while (at !== -1) {
      const open = text.lastIndexOf('{', at);
      const close = text.indexOf('}', at);
      if (open !== -1 && close !== -1 && at - open < 4000 && close - at < 4000) {
        const body = text.slice(open, close + 1);
        if (!body.slice(1).includes('{') && /[{,]"?user"?:"transcript"/.test(body)) {
          return uniqueSorted([...body.matchAll(/[{,]\s*(?:"([a-z][a-z0-9_-]*)"|([a-z][a-z0-9_]*)):"([a-z-]+)"/g)]
            .map((m) => `${m[1] ?? m[2]}=${m[3]}`));
        }
      }
      at = text.indexOf(needle, at + 1);
    }
  }
  return [];
}

export const EXTRACTORS: Extractor[] = [
  { name: 'merge-strategy map', extract: extractMergeMap },
  // Every short `type:"…"` literal. Broad on purpose: attachment subtypes
  // (`project_doc_reads`, 2.1.310) ride the `attachment` record and never
  // reach the merge map, so this is where they show up.
  { name: 'type literals', extract: (t) => all(/\btype:"([a-z][a-z0-9_-]{2,40})"/g, t) },
  { name: 'subtype literals', extract: (t) => all(/\bsubtype:"([a-z][a-z0-9_]*)"/g, t) },
  { name: 'hook_event_name', extract: (t) => all(/hook_event_name:"([A-Za-z]+)"/g, t) },
  { name: 'control envelopes', extract: (t) => all(/type:"(control_[a-z_]+)"/g, t) },
  { name: 'SDK control requests', extract: (t) => all(/this\.request\(\{subtype:"([a-z_]+)"/g, t) },
  { name: 'CLI flags', extract: (t) => all(/(?:\.option|Option)\("(?:-[a-zA-Z], )?(--[a-zA-Z][a-zA-Z-]*)/g, t) },
  // Allowed `origin.kind` values on user records. 2.1.277 began treating an
  // absent origin as non-human and stopped naming those sessions; our fix
  // was stamping {kind:"human"} (claude-cli-engine.ts writeUserMessage).
  { name: 'origin kinds', extract: (t) => all(/origin:\{kind:"([a-z_-]+)"/g, t) },
  // The fields of the permission request the stdio decider answers.
  {
    name: 'can_use_tool payload keys',
    extract: (t) => uniqueSorted([...t.matchAll(/subtype:"can_use_tool",([^}]{0,900})/g)]
      .flatMap((m) => [...m[1].matchAll(/(?:^|[,{])\s*(?:\.\.\.[^{]*\{)?([a-z][a-z_]*):/g)].map((k) => k[1]))),
  },
  // Every object-literal key. Mostly minifier and telemetry noise; read it
  // for new fields on records we already classify — the class of change the
  // type sets cannot see.
  { name: 'object keys', extract: (t) => all(/[{,]([a-zA-Z_][a-zA-Z0-9_]{3,40}):/g, t) },
  // Where the stream-json schemas document what a host must do. The cap is
  // generous on purpose: the init `capabilities` text runs past 2,000
  // characters, and an 800 cap hid 2.1.312's new obligation in it.
  { name: '.describe() strings', extract: (t) => all(/\.describe\("((?:[^"\\]|\\.){10,8000})"\)/g, t) },
];

/**
 * Strings the `/usage` scraper keys on. A copy, because the parser holds them
 * inside regexes; the test holds every entry to `usage-runner/parser.ts`.
 */
export const USAGE_ANCHORS = [
  'Current session',
  'Current week',
  "What's contributing to your usage",
  "What's contributing to your limits usage",
  'Total cost:',
];

export function diffSets(from: string[], to: string[]): { added: string[]; removed: string[] } {
  const a = new Set(from);
  const b = new Set(to);
  return { added: to.filter((x) => !a.has(x)), removed: from.filter((x) => !b.has(x)) };
}

export interface Inventory {
  hookEvents: readonly string[];
  /** Every control request the catalog has classified, whatever its status. */
  catalogued: ReadonlySet<string>;
  controlSubtypesSent: string[];
  cliFlagsPassed: string[];
  /** True when OmniFex would draw this record type as an "Unrecognized record" card. */
  isUnrecognizedRecord(type: string): boolean;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Record types the classifier leaves as `unknown` on purpose because
 * StreamMessage draws them from there (`summary` → SummaryWidget). The test
 * holds each to a branch in StreamMessage.tsx.
 */
export const RENDERED_FROM_UNKNOWN = ['summary'];

/** Flags only the Claude CLI takes — a file holding one of these spawns `claude`. */
const CLAUDE_SPAWN_MARKERS = ["'--output-format'", "'--mcp-config'", "'--setting-sources'", "'--permission-prompt-tool'"];

/**
 * What OmniFex depends on, read from the code itself: the classifier and the
 * sidechannel set are imported and asked, the hook list is imported, and the
 * control subtypes and spawn flags are collected from every daemon source.
 */
export async function loadInventory(repoRoot: string): Promise<Inventory> {
  const load = (rel: string) => import(pathToFileURL(path.join(repoRoot, rel)).href);
  const { classifyJsonlLine } = await load('src/lib/jsonlClassifier.ts');
  const { CLI_SIDECHANNEL_RECORD_TYPES } = await load('src/lib/cliSidechannelRecords.ts');
  const { HOOK_EVENTS } = await load('src/types/hooks.ts');
  const { CLI_CONTROL_REQUESTS } = await load('electron/services/sessions/cli-control-catalog.ts');

  const sources = walk(path.join(repoRoot, 'electron/services')).map((f) => fs.readFileSync(f, 'utf8'));
  // `mcpControl` is queries.ts's wrapper for the mcp_* family; the test pins
  // it, so renaming the wrapper fails there rather than here.
  const sent = sources.flatMap((s) =>
    [...s.matchAll(/(?:sendControlRequest|mcpControl)\s*(?:<[\s\S]{0,400}?>)?\(\s*'([a-z_]+)'/g)].map((m) => m[1]));
  const flags = sources
    .filter((s) => CLAUDE_SPAWN_MARKERS.some((m) => s.includes(m)))
    .flatMap((s) => [...s.matchAll(/'(--[a-zA-Z][a-zA-Z-]+)'/g)].map((m) => m[1]));

  return {
    hookEvents: HOOK_EVENTS,
    catalogued: new Set(Object.keys(CLI_CONTROL_REQUESTS)),
    controlSubtypesSent: uniqueSorted(sent),
    cliFlagsPassed: uniqueSorted(flags),
    isUnrecognizedRecord: (type) =>
      !CLI_SIDECHANNEL_RECORD_TYPES.has(type) &&
      !RENDERED_FROM_UNKNOWN.includes(type) &&
      classifyJsonlLine({ type, timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'probe' })?.kind === 'unknown',
  };
}

export interface CoverageFinding {
  check: string;
  /** What a non-empty list means for the current build. */
  meaning: string;
  items: string[];
}

export function coverage(text: string, inv: Inventory): CoverageFinding[] {
  const hooks = all(/hook_event_name:"([A-Za-z]+)"/g, text);
  const sdkRequests = all(/this\.request\(\{subtype:"([a-z_]+)"/g, text);
  return [
    {
      check: 'record types OmniFex would draw as Unrecognized',
      meaning: 'BUG once the CLI writes one (check transcripts): classify it in src/lib/jsonlClassifier.ts or list it in src/lib/cliSidechannelRecords.ts',
      // The four `transcript` types are the classifier's own cases; a probe
      // with no fields would misread `system` as unknown, so only the
      // bookkeeping types are asked.
      items: extractMergeMap(text)
        .map((kv) => kv.split('='))
        .filter(([, strategy]) => strategy !== 'transcript')
        .map(([type]) => type)
        .filter((t) => inv.isUnrecognizedRecord(t)),
    },
    {
      check: 'hook events missing from HOOK_EVENTS',
      meaning: 'gap: the hooks editor cannot add these (src/types/hooks.ts)',
      items: hooks.filter((h) => !inv.hookEvents.includes(h)),
    },
    {
      check: 'HOOK_EVENTS the binary never fires',
      meaning: 'stale or renamed event in src/types/hooks.ts',
      items: inv.hookEvents.filter((h) => !hooks.includes(h)),
    },
    {
      check: 'control subtypes we send that the binary lacks',
      meaning: 'BUG if confirmed: the request will fail or hang',
      items: inv.controlSubtypesSent.filter((s) => !text.includes(`subtype:"${s}"`) && !text.includes(`case"${s}"`)),
    },
    {
      check: 'CLI flags we pass that the binary lacks',
      meaning: 'BUG if confirmed: the spawn will exit on an unknown option',
      items: inv.cliFlagsPassed.filter((f) => !text.includes(f)),
    },
    {
      check: 'SDK control requests not in the catalog',
      meaning: 'new capability: classify it wired / planned / declined in electron/services/sessions/cli-control-catalog.ts',
      items: sdkRequests.filter((s) => !inv.catalogued.has(s)),
    },
    {
      check: 'catalog entries the SDK no longer offers',
      meaning: 'removed or renamed upstream: drop or update the entry',
      items: [...inv.catalogued].filter((s) => s !== 'initialize' && !sdkRequests.includes(s)).sort(),
    },
  ];
}

function resolveBundle(versionOrPath: string, versionsDir: string): string {
  return versionOrPath.includes('/') ? versionOrPath : path.join(versionsDir, versionOrPath);
}

function readBundle(p: string): string {
  // latin1 maps every byte to one char: the bundle is JS with binary around it.
  return fs.readFileSync(p, 'latin1');
}

const LIST_CAP = 40;

function listLines(prefix: string, items: string[], full: boolean): string[] {
  const cap = full ? Infinity : LIST_CAP;
  const shown = items.slice(0, cap).map((i) => `    ${prefix} ${!full && i.length > 240 ? `${i.slice(0, 240)}…` : i}`);
  if (items.length > cap) shown.push(`    … ${items.length - LIST_CAP} more (--full lists all)`);
  return shown;
}

export interface ReviewArgs {
  from: string;
  to: string;
  versionsDir: string;
  repoRoot: string;
  /** List every moved item, untruncated, instead of the first 40. */
  full?: boolean;
}

export async function runReview({ from, to, versionsDir, repoRoot, full = false }: ReviewArgs): Promise<{
  report: string;
  anchorsMissing: string[];
}> {
  const fromPath = resolveBundle(from, versionsDir);
  const toPath = resolveBundle(to, versionsDir);
  if (!fs.existsSync(toPath)) {
    throw new Error(`${to} is not installed (looked for ${toPath}); nothing to review against`);
  }
  const out: string[] = [`# Claude Code bundle review: ${from} -> ${to}`, ''];
  const anchorsMissing = new Set<string>();
  const toText = readBundle(toPath);
  const toSets = new Map(EXTRACTORS.map((e) => [e.name, e.extract(toText)]));
  for (const [name, set] of toSets) if (set.length === 0) anchorsMissing.add(name);

  out.push(`## Version to version`);
  if (!fs.existsSync(fromPath)) {
    out.push(`${from} is not installed (looked for ${fromPath}) — version diff skipped; coverage below still applies.`);
  } else {
    const fromText = readBundle(fromPath);
    for (const e of EXTRACTORS) {
      const a = e.extract(fromText);
      const b = toSets.get(e.name) ?? [];
      if (a.length === 0) anchorsMissing.add(e.name);
      if (a.length === 0 || b.length === 0) {
        out.push(`- ${e.name}: ANCHOR NOT FOUND (${from}: ${a.length}, ${to}: ${b.length})`);
        continue;
      }
      const { added, removed } = diffSets(a, b);
      if (added.length === 0 && removed.length === 0) {
        out.push(`- ${e.name}: same (${b.length})`);
      } else {
        out.push(`- ${e.name}: +${added.length} -${removed.length} (${a.length} -> ${b.length})`);
        out.push(...listLines('+', added, full), ...listLines('-', removed, full));
      }
    }
    out.push('', `## /usage anchors (occurrences ${from} -> ${to}; 0 means the scraper is blind)`);
    for (const a of USAGE_ANCHORS) {
      const before = fromText.split(a).length - 1;
      const after = toText.split(a).length - 1;
      // Any drop is worth a look: the binary embeds its own changelog, which
      // keeps quoting a reworded string after the UI stops rendering it.
      const dropped = after < before ? ' — DROPPED: check the string still renders, not just the changelog' : '';
      out.push(`- ${a}: ${before} -> ${after}${dropped}`);
    }
  }
  if (!fs.existsSync(fromPath)) {
    out.push('', `## /usage anchors in ${to} (0 means the scraper is blind)`);
    for (const a of USAGE_ANCHORS) out.push(`- ${a}: ${toText.split(a).length - 1}`);
  }

  out.push('', `## Installed ${to} vs OmniFex`);
  for (const f of coverage(toText, await loadInventory(repoRoot))) {
    out.push(`- ${f.check}: ${f.items.length === 0 ? 'none' : `${f.items.length} — ${f.meaning}`}`);
    out.push(...listLines('*', f.items, full));
  }
  if (anchorsMissing.size > 0) {
    out.push('', `ANCHOR NOT FOUND: ${[...anchorsMissing].join(', ')}. The CLI or this script moved — fix scripts/cli-review-diff.ts; an empty set is not a clean result.`);
  }
  return { report: out.join('\n'), anchorsMissing: [...anchorsMissing] };
}

async function main(argv: string[]): Promise<number> {
  const full = argv.includes('--full');
  const [from, to] = argv.filter((a) => a !== '--full');
  if (!from || !to) {
    console.error('usage: npm run cli-review:diff -- <reviewedVersion> <installedVersion> [--full]');
    return 1;
  }
  const versionsDir = process.env.CLAUDE_VERSIONS_DIR ?? path.join(os.homedir(), '.local/share/claude/versions');
  try {
    const { report, anchorsMissing } = await runReview({
      from, to, versionsDir, full, repoRoot: path.resolve(import.meta.dirname, '..'),
    });
    console.log(report);
    return anchorsMissing.length > 0 ? 2 : 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
