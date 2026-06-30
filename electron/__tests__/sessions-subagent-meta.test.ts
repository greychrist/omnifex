import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readSubagentMeta, type SubagentMetaFs } from '../services/sessions/subagent-meta';

const CONFIG_DIR = '/cfg';
const PROJECT_PATH = '/Users/me/proj';
const SESSION_ID = 'sess1';

// Mirror the service's path construction so the in-memory fs keys line up.
const PROJECT_DIR = path.join(CONFIG_DIR, 'projects', '-Users-me-proj');
const SESSION_FILE = path.join(PROJECT_DIR, `${SESSION_ID}.jsonl`);
const subagentFile = (agentId: string) =>
  path.join(PROJECT_DIR, SESSION_ID, 'subagents', `agent-${agentId}.jsonl`);

function fsFromMap(files: Record<string, string>): SubagentMetaFs {
  return {
    readFile: (p: string) => (p in files ? files[p] : null),
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

/** A subagent sidechain assistant line carrying the executed model. */
function sidechainAssistant(agentId: string, model: string): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    agentId,
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
