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
  /** Authoritative totals from the parent Task's `toolUseResult`. */
  totalTokens?: number;
  durationMs?: number;
  toolUseCount?: number;
  status?: string;
}

/** Minimal filesystem surface so the reader is unit-testable with an
 *  in-memory map. `readFile` returns the file contents, or `null` when the
 *  file does not exist (mirrors a swallowed ENOENT). */
export interface SubagentMetaFs {
  readFile(filePath: string): string | null;
}

const nodeFs: SubagentMetaFs = {
  readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
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
 * Extract `message.model` from the last assistant line in a subagent
 * transcript. Returns undefined if the file is missing or carries no model.
 */
function readSubagentModel(
  deps: SubagentMetaFs,
  subagentsDir: string,
  agentId: string,
): string | undefined {
  const contents = deps.readFile(path.join(subagentsDir, `agent-${agentId}.jsonl`));
  if (contents === null) return undefined;
  let model: string | undefined;
  for (const line of nonEmptyLines(contents)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = parsed as { type?: unknown; message?: { model?: unknown } };
    if (obj.type !== 'assistant') continue;
    const m = obj.message?.model;
    if (typeof m === 'string' && m.length > 0) model = m; // last assistant model wins
  }
  return model;
}

/**
 * Build a `tool_use_id → SubagentMeta` map for one session by reading the
 * on-disk JSONL (main session file + per-subagent transcripts).
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

    out[toolUseId] = {
      agentId: tur.agentId,
      agentType: typeof tur.agentType === 'string' ? tur.agentType : undefined,
      status: typeof tur.status === 'string' ? tur.status : undefined,
      totalTokens: typeof tur.totalTokens === 'number' ? tur.totalTokens : undefined,
      durationMs: typeof tur.totalDurationMs === 'number' ? tur.totalDurationMs : undefined,
      toolUseCount:
        typeof tur.totalToolUseCount === 'number' ? tur.totalToolUseCount : undefined,
      model: readSubagentModel(deps, subagentsDir, tur.agentId),
    };
  }

  return out;
}
