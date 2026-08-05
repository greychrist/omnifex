import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readSubagentMeta, type SubagentMetaFs } from '../services/sessions/subagent-meta';

const CONFIG_DIR = '/cfg';
const PROJECT_PATH = '/Users/me/proj';
const SESSION_ID = 'sess1';

// Mirror the service's path construction so the in-memory fs keys line up.
const PROJECT_DIR = path.join(CONFIG_DIR, 'projects', '-Users-me-proj');
const SESSION_FILE = path.join(PROJECT_DIR, `${SESSION_ID}.jsonl`);
const SUBAGENTS_DIR = path.join(PROJECT_DIR, SESSION_ID, 'subagents');
const subagentFile = (agentId: string) =>
  path.join(SUBAGENTS_DIR, `agent-${agentId}.jsonl`);
const subagentMetaFile = (agentId: string) =>
  path.join(SUBAGENTS_DIR, `agent-${agentId}.meta.json`);

/**
 * The CLI writes a `.meta.json` sidecar beside every subagent transcript.
 * Verified live: 100% coverage across both of Greg's config dirs (396/396).
 * `parentAgentId` is present only at spawnDepth >= 2.
 */
function sidecar(fields: {
  agentType?: string;
  description?: string;
  toolUseId: string;
  parentAgentId?: string;
  spawnDepth?: number;
}): string {
  return JSON.stringify(fields);
}

function fsFromMap(files: Record<string, string>): SubagentMetaFs {
  return {
    readFile: (p: string) => (p in files ? files[p] : null),
    listFiles: (dir: string) =>
      Object.keys(files)
        .filter((p) => path.dirname(p) === dir)
        .map((p) => path.basename(p)),
  };
}

/** A main-session tool_result line carrying the rich `toolUseResult` enrichment. */
function toolResultLine(
  toolUseId: string,
  result: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    },
    toolUseResult: result,
  });
}

/**
 * A subagent sidechain assistant line carrying the executed model, and
 * optionally the subagent's own `effort` — a TOP-LEVEL string, sibling to
 * `message`, not inside it (verified against a real transcript).
 */
function sidechainAssistant(agentId: string, model: string, effort?: string): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    agentId,
    ...(effort === undefined ? {} : { effort }),
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'hi' }] },
  });
}

describe('readSubagentMeta', () => {
  it('maps tool_use_id to authoritative stats + the subagent model', () => {
    const files = {
      [SESSION_FILE]: [
        toolResultLine('toolu_1', {
          agentId: 'aaa111',
          agentType: 'code-reviewer',
          status: 'completed',
          totalDurationMs: 53161,
          totalTokens: 71591,
          totalToolUseCount: 20,
        }),
      ].join('\n'),
      [subagentFile('aaa111')]: [
        sidechainAssistant('aaa111', 'claude-haiku-4-5-20251001'),
      ].join('\n'),
    };

    const meta = readSubagentMeta(
      { configDir: CONFIG_DIR, projectPath: PROJECT_PATH, sessionId: SESSION_ID },
      fsFromMap(files),
    );

    expect(meta).toEqual({
      toolu_1: {
        agentId: 'aaa111',
        agentType: 'code-reviewer',
        model: 'claude-haiku-4-5-20251001',
        totalTokens: 71591,
        durationMs: 53161,
        toolUseCount: 20,
        status: 'completed',
      },
    });
  });

  it('returns stats even when the subagent file is missing (model undefined)', () => {
    const files = {
      [SESSION_FILE]: toolResultLine('toolu_2', {
        agentId: 'bbb222',
        agentType: 'Explore',
        status: 'completed',
        totalDurationMs: 1000,
        totalTokens: 500,
        totalToolUseCount: 3,
      }),
    };

    const meta = readSubagentMeta(
      { configDir: CONFIG_DIR, projectPath: PROJECT_PATH, sessionId: SESSION_ID },
      fsFromMap(files),
    );

    expect(meta.toolu_2).toMatchObject({ agentId: 'bbb222', totalTokens: 500 });
    expect(meta.toolu_2.model).toBeUndefined();
  });

  it('uses the last assistant model when the subagent switched models mid-run', () => {
    const files = {
      [SESSION_FILE]: toolResultLine('toolu_3', { agentId: 'ccc333' }),
      [subagentFile('ccc333')]: [
        sidechainAssistant('ccc333', 'claude-haiku-4-5-20251001'),
        sidechainAssistant('ccc333', 'claude-opus-4-8'),
      ].join('\n'),
    };

    const meta = readSubagentMeta(
      { configDir: CONFIG_DIR, projectPath: PROJECT_PATH, sessionId: SESSION_ID },
      fsFromMap(files),
    );

    expect(meta.toolu_3.model).toBe('claude-opus-4-8');
  });

  it('ignores main-session lines without a toolUseResult.agentId', () => {
    const files = {
      [SESSION_FILE]: [
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }),
        toolResultLine('toolu_4', { type: 'text', file: { filePath: '/x' } }), // a plain file-read result, no agentId
      ].join('\n'),
    };

    const meta = readSubagentMeta(
      { configDir: CONFIG_DIR, projectPath: PROJECT_PATH, sessionId: SESSION_ID },
      fsFromMap(files),
    );

    expect(meta).toEqual({});
  });

  it('returns an empty map when the session file is missing', () => {
    const meta = readSubagentMeta(
      { configDir: CONFIG_DIR, projectPath: PROJECT_PATH, sessionId: SESSION_ID },
      fsFromMap({}),
    );
    expect(meta).toEqual({});
  });
});

// Nested subagents are the case the main-stream scan cannot see. Verified
// against a real depth-2 run: the grandchild's dispatching tool_use is issued
// inside its PARENT's transcript, never appears in the main stream, and gets
// no `toolUseResult.agentId` line anywhere. The sidecars are the only record.
describe('readSubagentMeta — nested subagents via .meta.json sidecars', () => {
  // Mirrors the real probe: depth-1 agent dispatched from main, depth-2
  // dispatched from inside the depth-1 agent.
  const nested = () =>
    fsFromMap({
      [SESSION_FILE]: toolResultLine('toolu_parent', {
        agentId: 'a987',
        agentType: 'general-purpose',
        status: 'completed',
        totalTokens: 5000,
        totalDurationMs: 1234,
        totalToolUseCount: 3,
      }),
      [subagentMetaFile('a987')]: sidecar({
        agentType: 'general-purpose',
        description: 'Nested subagent txt count',
        toolUseId: 'toolu_parent',
        spawnDepth: 1,
      }),
      [subagentFile('a987')]: sidechainAssistant('a987', 'claude-opus-4-8'),
      [subagentMetaFile('a843')]: sidecar({
        agentType: 'general-purpose',
        description: 'Count txt files',
        toolUseId: 'toolu_child',
        parentAgentId: 'a987',
        spawnDepth: 2,
      }),
      [subagentFile('a843')]: sidechainAssistant('a843', 'claude-haiku-4-5-20251001', 'low'),
    });

  const read = () =>
    readSubagentMeta(
      { configDir: CONFIG_DIR, projectPath: PROJECT_PATH, sessionId: SESSION_ID },
      nested(),
    );

  it('includes the depth-2 subagent the main stream never mentions', () => {
    const meta = read();
    expect(Object.keys(meta).sort()).toEqual(['toolu_child', 'toolu_parent']);
  });

  it('records the parent link and depth', () => {
    const meta = read();
    expect(meta.toolu_child.parentAgentId).toBe('a987');
    expect(meta.toolu_child.spawnDepth).toBe(2);
    // Depth 1 has no parent — it was dispatched from the main stream.
    expect(meta.toolu_parent.parentAgentId).toBeUndefined();
    expect(meta.toolu_parent.spawnDepth).toBe(1);
  });

  it('reads model and effort for the nested agent too', () => {
    const meta = read();
    expect(meta.toolu_child.model).toBe('claude-haiku-4-5-20251001');
    expect(meta.toolu_child.effort).toBe('low');
    expect(meta.toolu_child.agentId).toBe('a843');
    expect(meta.toolu_child.agentType).toBe('general-purpose');
  });

  it('still merges main-stream totals onto the agent that has them', () => {
    // The sidecar carries no token/duration counts — those only exist on the
    // dispatching Task's toolUseResult, which only depth-1 agents get.
    const meta = read();
    expect(meta.toolu_parent).toMatchObject({
      totalTokens: 5000,
      durationMs: 1234,
      toolUseCount: 3,
      status: 'completed',
    });
    expect(meta.toolu_child.totalTokens).toBeUndefined();
  });

  it('falls back to the main-stream scan when a sidecar is missing', () => {
    // A partially-written run can leave a transcript without its sidecar;
    // dropping the subagent entirely would be worse than losing the depth.
    const meta = readSubagentMeta(
      { configDir: CONFIG_DIR, projectPath: PROJECT_PATH, sessionId: SESSION_ID },
      fsFromMap({
        [SESSION_FILE]: toolResultLine('toolu_parent', {
          agentId: 'a987',
          agentType: 'code-reviewer',
          totalTokens: 42,
        }),
        [subagentFile('a987')]: sidechainAssistant('a987', 'claude-opus-4-8'),
      }),
    );
    expect(meta.toolu_parent).toMatchObject({
      agentId: 'a987',
      agentType: 'code-reviewer',
      model: 'claude-opus-4-8',
      totalTokens: 42,
    });
    expect(meta.toolu_parent.spawnDepth).toBeUndefined();
  });

  it('ignores an unparseable sidecar rather than dropping the session', () => {
    const meta = readSubagentMeta(
      { configDir: CONFIG_DIR, projectPath: PROJECT_PATH, sessionId: SESSION_ID },
      fsFromMap({
        [SESSION_FILE]: toolResultLine('toolu_parent', { agentId: 'a987' }),
        [subagentMetaFile('a987')]: '{ not json',
        [subagentFile('a987')]: sidechainAssistant('a987', 'claude-opus-4-8'),
      }),
    );
    // Main-stream fallback still produces the row.
    expect(meta.toolu_parent.agentId).toBe('a987');
  });

  it('skips a sidecar with no toolUseId — there is no key to file it under', () => {
    const meta = readSubagentMeta(
      { configDir: CONFIG_DIR, projectPath: PROJECT_PATH, sessionId: SESSION_ID },
      fsFromMap({
        [SESSION_FILE]: '',
        [subagentMetaFile('a843')]: sidecar({ toolUseId: '' } as never),
        [subagentFile('a843')]: sidechainAssistant('a843', 'claude-opus-4-8'),
      }),
    );
    expect(meta).toEqual({});
  });
});

// The CLI reports a subagent's own `effort:` separately from the session's
// (2.1.222 fixed the spinner that conflated the two). It only exists in the
// subagent's transcript, so it rides in alongside the model read.
describe('readSubagentMeta — per-subagent effort', () => {
  const withSubagent = (subagentLines: string[]) =>
    fsFromMap({
      [SESSION_FILE]: toolResultLine('toolu_1', { agentId: 'aaa111' }),
      [subagentFile('aaa111')]: subagentLines.join('\n'),
    });

  const read = (deps: SubagentMetaFs) =>
    readSubagentMeta(
      { configDir: CONFIG_DIR, projectPath: PROJECT_PATH, sessionId: SESSION_ID },
      deps,
    );

  it('reads the top-level effort off the subagent transcript', () => {
    const meta = read(withSubagent([sidechainAssistant('aaa111', 'claude-opus-4-8', 'high')]));
    expect(meta.toolu_1.effort).toBe('high');
  });

  it('leaves effort undefined when the transcript carries none', () => {
    // Effort is absent whenever the run used the session default, so a
    // missing field must not become an empty string in the UI.
    const meta = read(withSubagent([sidechainAssistant('aaa111', 'claude-opus-4-8')]));
    expect(meta.toolu_1.effort).toBeUndefined();
    expect(meta.toolu_1.model).toBe('claude-opus-4-8');
  });

  it('takes the LAST assistant line\'s effort, matching the model rule', () => {
    const meta = read(
      withSubagent([
        sidechainAssistant('aaa111', 'claude-opus-4-8', 'low'),
        sidechainAssistant('aaa111', 'claude-opus-4-8', 'max'),
      ]),
    );
    expect(meta.toolu_1.effort).toBe('max');
  });

  it('ignores a non-string effort', () => {
    const line = JSON.stringify({
      type: 'assistant',
      agentId: 'aaa111',
      effort: 3,
      message: { role: 'assistant', model: 'claude-opus-4-8', content: [] },
    });
    const meta = read(withSubagent([line]));
    expect(meta.toolu_1.effort).toBeUndefined();
  });

  it('does not read effort off non-assistant lines', () => {
    const userLine = JSON.stringify({
      type: 'user',
      agentId: 'aaa111',
      effort: 'max',
      message: { role: 'user', content: [] },
    });
    const meta = read(
      withSubagent([userLine, sidechainAssistant('aaa111', 'claude-opus-4-8')]),
    );
    expect(meta.toolu_1.effort).toBeUndefined();
  });
});
