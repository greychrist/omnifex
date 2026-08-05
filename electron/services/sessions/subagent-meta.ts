// Sessions module — subagent metadata reader.
//
// The SubagentBar in the renderer is built from the parent session's
// message stream (task_started / task_progress / task_notification +
// tool_result). That stream does NOT carry two things the user wants to
// see per subagent:
//
//   1. The model the subagent actually ran on. That only exists in the
//      subagent's own transcript, which the CLI persists to a SEPARATE
//      file: `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`
//      (each assistant line carries `message.model`).
//   2. Authoritative end-of-run totals (duration, tokens, tool-use count).
//      The CLI writes these onto the parent Task's `tool_result` line as a
//      `toolUseResult` enrichment — but only in the on-disk JSONL, never in
//      the live stream-json output.
//
// Both live on disk regardless of whether the session is live or being
// replayed, so this reader works the same in both cases. It scans the main
// session JSONL for `toolUseResult.agentId` lines (giving the
// tool_use_id → {agentId, stats} mapping), then reads each referenced
// subagent file for the model, and returns a map keyed by `tool_use_id`
// (the key the SubagentBar rows are already keyed by).

import path from 'node:path';
import fs from 'node:fs';
import { encodeProjectKey } from './summary-query';

export interface SubagentMeta {
  agentId?: string;
  agentType?: string;
  /** The model the subagent ran on, from the last assistant turn in its
   *  transcript. Undefined when the subagent file is absent/unreadable. */
  model?: string;
  /** The subagent's OWN reasoning effort — which can differ from the
   *  session's when the dispatch set `effort:`. Same provenance as `model`:
   *  a top-level field on the subagent transcript's assistant lines.
   *  Undefined when the run used the session default. */
  effort?: string;
  /** Authoritative totals from the parent Task's `toolUseResult`. Present
   *  only for subagents dispatched from the MAIN stream — a nested
   *  subagent's Task result lives in its parent's transcript and carries no
   *  `agentId`, so there is nothing to attribute. */
  totalTokens?: number;
  durationMs?: number;
  toolUseCount?: number;
  status?: string;
  /** agentId of the subagent that dispatched this one. Undefined at depth 1
   *  (dispatched from the main stream). Sidecar-only. */
  parentAgentId?: string;
  /** 1 for a subagent of the main session, 2+ for nested. Sidecar-only, so
   *  undefined when a transcript has no `.meta.json` beside it. */
  spawnDepth?: number;
}

/** Minimal filesystem surface so the reader is unit-testable with an
 *  in-memory map. `readFile` returns the file contents, or `null` when the
 *  file does not exist (mirrors a swallowed ENOENT). `listFiles` returns bare
 *  filenames, or `[]` when the directory is absent. */
export interface SubagentMetaFs {
  readFile(filePath: string): string | null;
  listFiles(dirPath: string): string[];
}

const nodeFs: SubagentMetaFs = {
  readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  },
  listFiles(dirPath: string): string[] {
    try {
      return fs.readdirSync(dirPath);
    } catch {
      return [];
    }
  },
};

export interface ReadSubagentMetaArgs {
  configDir: string;
  projectPath: string;
  sessionId: string;
}

function nonEmptyLines(contents: string): string[] {
  return contents.split('\n').filter((l) => l.trim().length > 0);
}

/**
 * Extract the executed model and reasoning effort from the last assistant
 * line in a subagent transcript. Note the asymmetry, which is how the CLI
 * writes them: `model` is nested under `message`, `effort` is top-level.
 * Both fields are absent when the file is missing or carries neither.
 */
function readSubagentRunProfile(
  deps: SubagentMetaFs,
  subagentsDir: string,
  agentId: string,
): { model?: string; effort?: string } {
  const contents = deps.readFile(path.join(subagentsDir, `agent-${agentId}.jsonl`));
  if (contents === null) return {};
  let model: string | undefined;
  let effort: string | undefined;
  for (const line of nonEmptyLines(contents)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = parsed as { type?: unknown; effort?: unknown; message?: { model?: unknown } };
    if (obj.type !== 'assistant') continue;
    // Last assistant line wins for both — the run's final state is the one
    // worth showing.
    const m = obj.message?.model;
    if (typeof m === 'string' && m.length > 0) model = m;
    const e = obj.effort;
    if (typeof e === 'string' && e.length > 0) effort = e;
  }
  return { model, effort };
}

/** One `.meta.json` sidecar, narrowed. */
interface SubagentSidecar {
  agentId: string;
  toolUseId: string;
  agentType?: string;
  parentAgentId?: string;
  spawnDepth?: number;
}

/**
 * Read every `agent-<id>.meta.json` sidecar in a session's subagents dir.
 *
 * These are the ONLY record of nested subagents. A depth-2 agent's
 * dispatching `tool_use` is issued inside its parent's transcript, never
 * appears in the main stream, and gets no `toolUseResult.agentId` line
 * anywhere — so the main-stream scan below cannot see it at all. Verified
 * against a real depth-2 run.
 */
function readSidecars(deps: SubagentMetaFs, subagentsDir: string): SubagentSidecar[] {
  const out: SubagentSidecar[] = [];
  for (const name of deps.listFiles(subagentsDir)) {
    const match = /^agent-(.+)\.meta\.json$/.exec(name);
    if (!match) continue;
    const contents = deps.readFile(path.join(subagentsDir, name));
    if (contents === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      // A half-written sidecar must not take the whole session's meta down.
      continue;
    }
    const o = parsed as {
      toolUseId?: unknown;
      agentType?: unknown;
      parentAgentId?: unknown;
      spawnDepth?: unknown;
    };
    // Without a toolUseId there is no key to file the entry under — the
    // SubagentBar rows are keyed by the dispatching Task's tool_use id.
    if (typeof o.toolUseId !== 'string' || o.toolUseId.length === 0) continue;
    out.push({
      agentId: match[1],
      toolUseId: o.toolUseId,
      agentType: typeof o.agentType === 'string' ? o.agentType : undefined,
      parentAgentId: typeof o.parentAgentId === 'string' ? o.parentAgentId : undefined,
      spawnDepth: typeof o.spawnDepth === 'number' ? o.spawnDepth : undefined,
    });
  }
  return out;
}

/**
 * Build a `tool_use_id → SubagentMeta` map for one session by reading the
 * on-disk JSONL (main session file + per-subagent transcripts + sidecars).
 *
 * Two sources, deliberately: the sidecars enumerate every subagent at every
 * depth and carry the tree structure, while the main stream's
 * `toolUseResult` carries the authoritative token/duration/tool-count totals
 * that the sidecars lack. Neither alone is sufficient.
 */
export function readSubagentMeta(
  args: ReadSubagentMetaArgs,
  deps: SubagentMetaFs = nodeFs,
): Record<string, SubagentMeta> {
  const projectDir = path.join(
    args.configDir,
    'projects',
    encodeProjectKey(args.projectPath),
  );
  const sessionContents = deps.readFile(path.join(projectDir, `${args.sessionId}.jsonl`));
  if (sessionContents === null) return {};

  const subagentsDir = path.join(projectDir, args.sessionId, 'subagents');
  const out: Record<string, SubagentMeta> = {};

  // Sidecars first — they establish the full set of subagents. The
  // main-stream pass below then enriches the ones that have totals, and
  // backfills any subagent whose sidecar is missing or unreadable.
  for (const s of readSidecars(deps, subagentsDir)) {
    const profile = readSubagentRunProfile(deps, subagentsDir, s.agentId);
    out[s.toolUseId] = {
      agentId: s.agentId,
      agentType: s.agentType,
      parentAgentId: s.parentAgentId,
      spawnDepth: s.spawnDepth,
      model: profile.model,
      effort: profile.effort,
    };
  }

  for (const line of nonEmptyLines(sessionContents)) {
    // Cheap pre-filter — only lines that could carry a subagent result.
    if (!line.includes('toolUseResult') || !line.includes('agentId')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = parsed as {
      toolUseResult?: {
        agentId?: unknown;
        agentType?: unknown;
        status?: unknown;
        totalTokens?: unknown;
        totalDurationMs?: unknown;
        totalToolUseCount?: unknown;
      };
      message?: { content?: unknown };
    };
    const tur = obj.toolUseResult;
    if (!tur || typeof tur.agentId !== 'string') continue;

    // Find the tool_use_id this result closes.
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    let toolUseId: string | undefined;
    for (const block of content as Array<{ type?: unknown; tool_use_id?: unknown }>) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        toolUseId = block.tool_use_id;
        break;
      }
    }
    if (!toolUseId) continue;

    // Already indexed from its sidecar? Keep the sidecar's structural fields
    // (parent link, depth) and layer the totals on top. Otherwise this is a
    // subagent whose sidecar is missing or unreadable — build the entry from
    // the main stream alone, minus the depth information only the sidecar has.
    const existing = out[toolUseId];
    const profile = existing ?? readSubagentRunProfile(deps, subagentsDir, tur.agentId);
    out[toolUseId] = {
      ...existing,
      agentId: tur.agentId,
      agentType:
        existing?.agentType ?? (typeof tur.agentType === 'string' ? tur.agentType : undefined),
      status: typeof tur.status === 'string' ? tur.status : undefined,
      totalTokens: typeof tur.totalTokens === 'number' ? tur.totalTokens : undefined,
      durationMs: typeof tur.totalDurationMs === 'number' ? tur.totalDurationMs : undefined,
      toolUseCount:
        typeof tur.totalToolUseCount === 'number' ? tur.totalToolUseCount : undefined,
      model: profile.model,
      effort: profile.effort,
    };
  }

  return out;
}
