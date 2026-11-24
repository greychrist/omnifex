// The model exists only in the subagent's own transcript, and run totals only in the on-disk `toolUseResult`, never in stream-json.

import path from 'node:path';
import fs from 'node:fs';
import { encodeProjectId } from '../project-paths';

export interface SubagentMeta {
  agentId?: string;
  agentType?: string;
  // For a nested subagent this is the only label; without it sibling rows are indistinguishable.
  description?: string;
  model?: string;
  effort?: string;
  // Main-stream subagents only: a nested one's Task result carries no `agentId`.
  totalTokens?: number;
  durationMs?: number;
  toolUseCount?: number;
  status?: string;
  parentAgentId?: string;
  spawnDepth?: number;
}

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

// The CLI nests `model` under `message` but writes `effort` top-level.
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
    const m = obj.message?.model;
    if (typeof m === 'string' && m.length > 0) model = m;
    const e = obj.effort;
    if (typeof e === 'string' && e.length > 0) effort = e;
  }
  return { model, effort };
}

interface SubagentSidecar {
  agentId: string;
  toolUseId: string;
  agentType?: string;
  description?: string;
  parentAgentId?: string;
  spawnDepth?: number;
}

// Sidecars are the only record of nested subagents: their dispatch never reaches the main stream.
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
      description?: unknown;
      parentAgentId?: unknown;
      spawnDepth?: unknown;
    };
    if (typeof o.toolUseId !== 'string' || o.toolUseId.length === 0) continue;
    out.push({
      agentId: match[1],
      toolUseId: o.toolUseId,
      agentType: typeof o.agentType === 'string' ? o.agentType : undefined,
      description: typeof o.description === 'string' ? o.description : undefined,
      parentAgentId: typeof o.parentAgentId === 'string' ? o.parentAgentId : undefined,
      spawnDepth: typeof o.spawnDepth === 'number' ? o.spawnDepth : undefined,
    });
  }
  return out;
}

// EnterWorktree moves the transcript and its subagents/ folder into the worktree's directory.
function findSession(
  args: ReadSubagentMetaArgs,
  deps: SubagentMetaFs,
): { projectDir: string; sessionContents: string } | null {
  const projectsDir = path.join(args.configDir, 'projects');
  const primary = encodeProjectId(args.projectPath);
  for (const name of [primary, ...deps.listFiles(projectsDir).filter((n) => n !== primary)]) {
    const projectDir = path.join(projectsDir, name);
    const sessionContents = deps.readFile(path.join(projectDir, `${args.sessionId}.jsonl`));
    if (sessionContents !== null) return { projectDir, sessionContents };
  }
  return null;
}

// Two sources: sidecars list every subagent and the tree; the main stream carries the totals sidecars lack.
export function readSubagentMeta(
  args: ReadSubagentMetaArgs,
  deps: SubagentMetaFs = nodeFs,
): Record<string, SubagentMeta> {
  const found = findSession(args, deps);
  if (!found) return {};
  const { projectDir, sessionContents } = found;

  const subagentsDir = path.join(projectDir, args.sessionId, 'subagents');
  const out: Record<string, SubagentMeta> = {};

  for (const s of readSidecars(deps, subagentsDir)) {
    const profile = readSubagentRunProfile(deps, subagentsDir, s.agentId);
    out[s.toolUseId] = {
      agentId: s.agentId,
      agentType: s.agentType,
      description: s.description,
      parentAgentId: s.parentAgentId,
      spawnDepth: s.spawnDepth,
      model: profile.model,
      effort: profile.effort,
    };
  }

  for (const line of nonEmptyLines(sessionContents)) {
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

    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    let toolUseId: string | undefined;
    for (const block of content as { type?: unknown; tool_use_id?: unknown }[]) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        toolUseId = block.tool_use_id;
        break;
      }
    }
    if (!toolUseId) continue;

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
