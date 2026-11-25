/**
 * An extractor that finds nothing must fail (ANCHOR NOT FOUND, exit 2): an empty set reads exactly like "no change".
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

/** Several anchors, so the map is still found the day one of them is retired. */
const MERGE_MAP_ANCHORS = ['atis-latch', 'custom-title', 'ai-title', 'last-prompt', 'file-history-snapshot'];

/**
 * Accepted only if brace-free and holding `user:"transcript"`. The minifier leaves identifier keys
 * bare (`user:`) and quotes hyphenated ones (`"atis-latch":`): read both.
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

/** The merge map does not hold every appended record type (`repl-mode` has no merge strategy). */
export function extractSessionRecordTypes(text: string): string[] {
  return all(/\{type:"([a-z][a-z0-9_-]*)",[^{}]{0,300}?\bsessionId:/g, text);
}

/** The CLI's own table of frame types it forwards to an SDK host (`!0`) or keeps back (`!1`). */
export function extractStreamFrameTypes(text: string): string[] {
  for (const m of text.matchAll(/\{assistant:!0,[^{}]{0,2000}\}/g)) {
    const body = m[0];
    if (!/[{,]result:!0/.test(body)) continue;
    return uniqueSorted([...body.matchAll(/[{,]([a-z][a-z0-9_]*):!0/g)].map((k) => k[1]));
  }
  return [];
}

/** Only what can reach `classifySystem`: zod schemas (factory name minified) and inline frames. */
export function extractSystemSubtypes(text: string): string[] {
  return uniqueSorted([
    ...text.matchAll(/type:[A-Za-z_$][\w$]*\("system"\),subtype:[A-Za-z_$][\w$]*\("([a-z_]+)"\)/g),
    ...text.matchAll(/type:"system",subtype:"([a-z_]+)"/g),
  ].map((m) => m[1]));
}

/** Every control-request zod schema (`u({subtype:T("x")`), both directions. */
export function extractControlRequestSchemas(text: string): string[] {
  return all(/[A-Za-z_$][\w$]*\(\{subtype:[A-Za-z_$][\w$]*\("([a-z_]+)"\)/g, text);
}

/** Bracket-aware: a `[^}]` capture stops at the first nested `...cond&&{…}` spread and misses keys. */
export function extractCanUseToolKeys(text: string): string[] {
  const keys: string[] = [];
  const anchor = 'subtype:"can_use_tool",';
  for (let at = text.indexOf(anchor); at !== -1; at = text.indexOf(anchor, at + 1)) {
    // Stack of open brackets; a `{` entered through a spread at the top level
    // counts as top level too.
    const stack: { close: string; keys: boolean }[] = [];
    const end = Math.min(text.length, at + 4000);
    let i = at + anchor.length;
    let expectKey = true;
    while (i < end) {
      const ch = text[i];
      const readingKeys = stack.length === 0 || stack[stack.length - 1].keys;
      if (ch === '"' || ch === "'" || ch === '`') {
        // Skip a string; template `${…}` bodies are skipped with it.
        const q = ch;
        i++;
        while (i < end && text[i] !== q) i += text[i] === '\\' ? 2 : 1;
        i++;
        expectKey = false;
        continue;
      }
      if (ch === '{' || ch === '(' || ch === '[') {
        const spread = ch === '{' && readingKeys && /\.\.\.[^,]*&&\s*$/.test(text.slice(Math.max(at, i - 120), i));
        stack.push({ close: ch === '{' ? '}' : ch === '(' ? ')' : ']', keys: spread });
        expectKey = spread;
        i++;
        continue;
      }
      if (ch === '}' || ch === ')' || ch === ']') {
        if (stack.length === 0) break;
        stack.pop();
        expectKey = false;
        i++;
        continue;
      }
      if (ch === ',') {
        expectKey = readingKeys;
        i++;
        continue;
      }
      if (expectKey && readingKeys) {
        const m = /^([a-z][a-z_]*):/.exec(text.slice(i, i + 60));
        if (m) keys.push(m[1]);
        expectKey = false;
      }
      i++;
    }
  }
  return uniqueSorted(keys);
}

export const EXTRACTORS: Extractor[] = [
  { name: 'merge-strategy map', extract: extractMergeMap },
  // Broad on purpose: attachment subtypes ride the `attachment` record and never reach the merge map.
  { name: 'type literals', extract: (t) => all(/\btype:"([a-z][a-z0-9_-]{2,40})"/g, t) },
  { name: 'subtype literals', extract: (t) => all(/\bsubtype:"([a-z][a-z0-9_]*)"/g, t) },
  { name: 'system subtypes', extract: extractSystemSubtypes },
  { name: 'stream-json frame types', extract: extractStreamFrameTypes },
  { name: 'hook_event_name', extract: (t) => all(/hook_event_name:"([A-Za-z]+)"/g, t) },
  { name: 'control envelopes', extract: (t) => all(/type:"(control_[a-z_]+)"/g, t) },
  { name: 'SDK control requests', extract: (t) => all(/this\.request\(\{subtype:"([a-z_]+)"/g, t) },
  // `SDK control requests` sees only public SDK methods; this sees every schema, @internal ones too.
  { name: 'control request schemas', extract: (t) => extractControlRequestSchemas(t) },
  { name: 'CLI flags', extract: (t) => all(/(?:\.option|Option)\("(?:-[a-zA-Z], )?(--[a-zA-Z][a-zA-Z-]*)/g, t) },
  // The CLI treats an absent origin as non-human; writeUserMessage stamps {kind:"human"}.
  { name: 'origin kinds', extract: (t) => all(/origin:\{kind:"([a-z_-]+)"/g, t) },
  { name: 'can_use_tool payload keys', extract: extractCanUseToolKeys },
  // Mostly noise; catches new fields on already-classified records, which the type sets cannot see.
  { name: 'object keys', extract: (t) => all(/[{,]([a-zA-Z_][a-zA-Z0-9_]{3,40}):/g, t) },
  // Cap generous on purpose: the init `capabilities` text runs past 2,000 characters.
  { name: '.describe() strings', extract: (t) => all(/\.describe\("((?:[^"\\]|\\.){10,8000})"\)/g, t) },
];

/** A copy, because the parser holds these inside regexes; the test holds each to `usage-runner/parser.ts`. */
export const USAGE_ANCHORS = [
  'Current session',
  'Current week',
  "What's contributing to your usage",
  "What's contributing to your limits usage",
  'Total cost:',
  'Estimated cost:',
];

export function diffSets(from: string[], to: string[]): { added: string[]; removed: string[] } {
  const a = new Set(from);
  const b = new Set(to);
  return { added: to.filter((x) => !a.has(x)), removed: from.filter((x) => !b.has(x)) };
}

export interface Inventory {
  hookEvents: readonly string[];
  catalogued: ReadonlySet<string>;
  controlSubtypesSent: string[];
  cliFlagsPassed: string[];
  isUnrecognizedRecord(type: string): boolean;
  isUnrecognizedSystemSubtype(subtype: string): boolean;
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

/** Left `unknown` on purpose: the Modern renderer draws them from there. The test holds each to modernLines.ts. */
export const RENDERED_FROM_UNKNOWN = ['summary'];

/**
 * Judged never to reach a local stream-json host as a drawn row. If one ever draws a card, classify it
 * in jsonlClassifier.ts; the test forbids a classified subtype staying here.
 */
export const UNDRAWN_SYSTEM_SUBTYPES: Readonly<Record<string, string>> = {
  task_started: 'filtered', task_updated: 'filtered', task_progress: 'filtered',
  task_notification: 'filtered', task_summary: 'filtered',
  // Dropped by isTaskLifecycleMarker's `task_` prefix; taskList.ts reads it before that filter.
  task_list_statuses: 'filtered',
  session_state_changed: 'sdk opt-in', api_retry: 'sdk opt-in', files_persisted: 'sdk opt-in',
  file_attachments_missing: 'sdk opt-in', memory_recall: 'sdk opt-in', memory_saved: 'sdk opt-in',
  plugin_install: 'sdk opt-in', local_command_output: 'sdk opt-in', post_turn_summary: 'sdk opt-in',
  control_request_progress: 'sdk opt-in', permission_retry: 'sdk opt-in',
  inherited_asks_settled: 'sdk opt-in', instruction_size_warning: 'sdk opt-in',
  agents_killed: 'sdk opt-in', thinking: 'sdk opt-in', file_snapshot: 'sdk opt-in',
  bridge_state: 'remote', bridge_status: 'remote', cloud_session_delta: 'remote',
  cloud_session_status: 'remote', code_change_published: 'remote', mirror_error: 'remote',
  peer_message_hold: 'remote', scheduled_task_fire: 'remote', tool_host_result: 'remote',
  turn_handoff_available: 'remote', turn_preempted: 'remote', upgrade_relay_marker: 'remote',
  vcs_state_changed: 'remote', worker_shutting_down: 'remote', checkpoint_done: 'remote',
  rewind_stand_in: 'remote', turn_began_before_init: 'remote', turn_starting: 'remote',
  placed: 'remote',
  // Only to a self-hosted runner's activity fd, never stdout.
  start_folder: 'remote',
  // Stored form of a voice-call message; stdout carries the user form, and OmniFex never stamps that origin.
  voice_call_talk: 'host-only',
  // Needs the input-only `keeps_request_id`, which OmniFex never sends.
  late_allow_not_run: 'remote',
  // Only for an initialize hook matcher with `replacedByFrame`; OmniFex registers no hook callbacks.
  shell_cwd: 'host opt-in',
};

/** Forwarded to stream-json hosts, but judged never to reach the transcript as a row. */
export const UNDRAWN_STREAM_TYPES: Readonly<Record<string, string>> = {
  // AgentSession reads it for the live reply and returns before the transcript.
  stream_event: 'consumed live',
  // Only when initialize asks for promptSuggestions, which OmniFex never does.
  prompt_suggestion: 'sdk opt-in',
};

/** Flags only the Claude CLI takes — a file holding one of these spawns `claude`. */
const CLAUDE_SPAWN_MARKERS = ["'--output-format'", "'--mcp-config'", "'--setting-sources'", "'--permission-prompt-tool'"];

export async function loadInventory(repoRoot: string): Promise<Inventory> {
  const load = (rel: string) => import(pathToFileURL(path.join(repoRoot, rel)).href);
  const { classifyJsonlLine } = await load('src/lib/jsonlClassifier.ts');
  const { classifyStandaloneKind } = await load('src/lib/messageKind.ts');
  const { HOOK_EVENTS } = await load('src/types/hooks.ts');
  const { CLI_CONTROL_REQUESTS } = await load('daemon/services/sessions/cli-control-catalog.ts');

  const sources = walk(path.join(repoRoot, 'daemon/services')).map((f) => fs.readFileSync(f, 'utf8'));
  // `mcpControl` wraps the mcp_* family; the test pins the name.
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
    // Mirrors modernLineOf: an `unknown` node with no standalone kind is the "Unrecognized record" line.
    isUnrecognizedRecord: (type) => {
      if (RENDERED_FROM_UNKNOWN.includes(type)) return false;
      const node = classifyJsonlLine({ type, timestamp: '2026-01-01T00:00:00.000Z', sessionId: 'probe' });
      return node?.kind === 'unknown' && classifyStandaloneKind(node, [node]) === null;
    },
    isUnrecognizedSystemSubtype: (subtype) =>
      classifyJsonlLine({ type: 'system', subtype, timestamp: '2026-01-01T00:00:00.000Z', session_id: 'probe', uuid: 'probe' })?.kind === 'unknown',
  };
}

export interface CoverageFinding {
  check: string;
  meaning: string;
  items: string[];
}

export function coverage(text: string, inv: Inventory): CoverageFinding[] {
  const hooks = all(/hook_event_name:"([A-Za-z]+)"/g, text);
  const systemSubtypes = extractSystemSubtypes(text);
  const sdkRequests = all(/this\.request\(\{subtype:"([a-z_]+)"/g, text);
  // Offered includes @internal requests no SDK method sends.
  const offered = new Set([...sdkRequests, ...extractControlRequestSchemas(text)]);
  return [
    {
      check: 'record types OmniFex would draw as Unrecognized',
      meaning: 'BUG once the CLI writes one (check transcripts): classify it in src/lib/jsonlClassifier.ts or list it in src/lib/cliSidechannelRecords.ts',
      // Only bookkeeping types are probed: a field-less probe misreads `system` as unknown.
      items: uniqueSorted([
        ...extractMergeMap(text)
          .map((kv) => kv.split('='))
          .filter(([, strategy]) => strategy !== 'transcript')
          .map(([type]) => type),
        ...extractSessionRecordTypes(text),
      ]).filter((t) => inv.isUnrecognizedRecord(t)),
    },
    {
      check: 'stream-json frame types OmniFex would draw as Unrecognized',
      meaning: 'stdout-only, so no transcript shows them: read the emitter; if it reaches a stream-json host, give it a kind (src/lib/messageKind.ts) or consume it; if not, baseline it in UNDRAWN_STREAM_TYPES with why',
      // `system` is decided per subtype above; a field-less probe misreads it.
      items: extractStreamFrameTypes(text)
        .filter((t) => t !== 'system' && !(t in UNDRAWN_STREAM_TYPES) && inv.isUnrecognizedRecord(t)),
    },
    {
      check: 'system subtypes OmniFex would draw as Unrecognized',
      meaning: 'read the emitter: if a local stream-json host gets it, add it to SYSTEM_SUBTYPES (src/lib/jsonlClassifier.ts) with a render; if not, baseline it in UNDRAWN_SYSTEM_SUBTYPES with why',
      items: systemSubtypes.filter((s) => !(s in UNDRAWN_SYSTEM_SUBTYPES) && inv.isUnrecognizedSystemSubtype(s)),
    },
    {
      check: 'undrawn-subtype baseline entries the binary no longer has',
      meaning: 'stale: drop them from UNDRAWN_SYSTEM_SUBTYPES',
      items: Object.keys(UNDRAWN_SYSTEM_SUBTYPES).filter((s) => !systemSubtypes.includes(s)).sort(),
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
      meaning: 'new capability: classify it wired / planned / declined in daemon/services/sessions/cli-control-catalog.ts',
      items: sdkRequests.filter((s) => !inv.catalogued.has(s)),
    },
    {
      check: 'catalog entries the SDK no longer offers',
      meaning: 'removed or renamed upstream: drop or update the entry',
      items: [...inv.catalogued].filter((s) => s !== 'initialize' && !offered.has(s)).sort(),
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
