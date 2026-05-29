import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import {
  reduceSessionStreamMessage,
  EMPTY_METRICS_DELTA,
  type StreamReducerContext,
} from '../sessionStreamReducer';

const baseCtx: StreamReducerContext = {
  projectPath: '/Users/me/repo',
  hasExistingInit: false,
  hasExtractedSession: false,
  userInterrupted: false,
  messagesLength: 0,
};

// ── helpers that build JsonlNode fixtures ─────────────────────────────────────

// The CLI `system:init` envelope classifies to kind:'cli-stream-init'
// (jsonlClassifier routes every system:init there). The raw payload keeps
// its original shape, so session_id is still on raw.
function sysInit(sessionId = 'sess-1'): JsonlNode {
  return {
    kind: 'cli-stream-init',
    raw: { type: 'system', subtype: 'init', session_id: sessionId, sessionId } as never,
    sessionId,
    receivedAt: '2026-05-27T00:00:00Z',
  };
}

function compactBoundary(): JsonlNode {
  return {
    kind: 'system',
    subtype: 'compact_boundary',
    raw: { type: 'system', subtype: 'compact_boundary', sessionId: '' } as never,
    sessionId: '',
    receivedAt: '2026-05-27T00:00:00Z',
  };
}

/** `result` arrives as kind:'cli-stream-result' (jsonlClassifier routes every
 *  `type:'result'` line there). The raw payload keeps its original shape. */
function resultOk(): JsonlNode {
  return {
    kind: 'cli-stream-result',
    raw: { type: 'result', subtype: 'success', result: 'ok' } as never,
    sessionId: '',
    receivedAt: '2026-05-27T00:00:00Z',
  };
}

function resultErr(): JsonlNode {
  return {
    kind: 'cli-stream-result',
    raw: { type: 'result', subtype: 'error', is_error: true, result: 'boom' } as never,
    sessionId: '',
    receivedAt: '2026-05-27T00:00:00Z',
  };
}

function assistantNode(content: unknown[]): JsonlNode {
  return {
    kind: 'assistant',
    raw: {
      type: 'assistant',
      sessionId: '',
      timestamp: '2026-05-27T00:00:00Z',
      message: { role: 'assistant', content },
    } as never,
    sessionId: '',
    receivedAt: '2026-05-27T00:00:00Z',
  };
}

function userNode(content: unknown[]): JsonlNode {
  return {
    kind: 'user',
    userKind: 'tool-result',
    raw: {
      type: 'user',
      sessionId: '',
      timestamp: '2026-05-27T00:00:00Z',
      message: { role: 'user', content },
    } as never,
    sessionId: '',
    receivedAt: '2026-05-27T00:00:00Z',
  };
}

function systemErrorNode(): JsonlNode {
  return {
    kind: 'system',
    subtype: 'informational',
    raw: { type: 'system', subtype: 'error', error: 'oops', sessionId: '' } as never,
    sessionId: '',
    receivedAt: '2026-05-27T00:00:00Z',
  };
}

describe('reduceSessionStreamMessage', () => {
  it('system:init with new session id produces sessionIdUpdate, extractedSessionInfo, and fetch effects', () => {
    const r = reduceSessionStreamMessage(sysInit('new-sess'), {
      ...baseCtx,
      messagesLength: 3,
    });
    expect(r.sessionIdUpdate).toBe('new-sess');
    expect(r.extractedSessionInfo).toEqual({
      sessionId: 'new-sess',
      projectId: '-Users-me-repo',
    });
    const kinds = r.effects.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'saveSessionPersistence',
        'fetchAccountInfo',
        'refreshContextUsage',
        'fetchSupportedModels',
      ]),
    );
    const persist = r.effects.find((e) => e.kind === 'saveSessionPersistence');
    expect(persist).toMatchObject({
      sessionId: 'new-sess',
      projectId: '-Users-me-repo',
      messageCount: 3,
    });
    expect(r.append).toBe('insertBeforeFirstUser');
  });

  it('duplicate system:init does not append another init message but still emits fetch effects', () => {
    const r = reduceSessionStreamMessage(sysInit('same-sess'), {
      ...baseCtx,
      hasExistingInit: true,
      hasExtractedSession: true,
    });
    expect(r.append).toBe('skip');
    expect(r.sessionIdUpdate).toBe('same-sess');
    expect(r.extractedSessionInfo).toBeUndefined();
    expect(r.effects.find((e) => e.kind === 'saveSessionPersistence')).toBeUndefined();
    const kinds = r.effects.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'fetchAccountInfo',
        'refreshContextUsage',
        'fetchSupportedModels',
      ]),
    );
  });

  it('result message (unknown kind) clears loading and requests context usage refresh + queued prompt drain', () => {
    const r = reduceSessionStreamMessage(resultOk(), baseCtx);
    expect(r.clearLoading).toBe(true);
    expect(r.append).toBe('append');
    const kinds = r.effects.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['refreshContextUsage', 'processQueuedPrompt']),
    );
  });

  it('interrupted error result is suppressed when userInterrupted is true', () => {
    const r = reduceSessionStreamMessage(resultErr(), {
      ...baseCtx,
      userInterrupted: true,
    });
    expect(r.append).toBe('skip');
    expect(r.clearLoading).toBe(true);
    expect(r.clearUserInterrupted).toBe(true);
    expect(r.effects).toEqual([]);
  });

  it('compact_boundary requests context usage refresh and still appends', () => {
    const r = reduceSessionStreamMessage(compactBoundary(), baseCtx);
    expect(r.append).toBe('append');
    const kinds = r.effects.map((e) => e.kind);
    expect(kinds).toContain('refreshContextUsage');
  });

  it('userInterrupted but non-error result still appends and clears the flag', () => {
    const r = reduceSessionStreamMessage(resultOk(), {
      ...baseCtx,
      userInterrupted: true,
    });
    expect(r.append).toBe('append');
    expect(r.clearLoading).toBe(true);
    expect(r.clearUserInterrupted).toBe(true);
  });

  it('userInterrupted with is_error:false does NOT suppress', () => {
    const node: JsonlNode = {
      kind: 'cli-stream-result',
      raw: { type: 'result', subtype: 'error_max_turns', is_error: false, result: '' } as never,
      sessionId: '',
      receivedAt: '2026-05-27T00:00:00Z',
    };
    const r = reduceSessionStreamMessage(node, { ...baseCtx, userInterrupted: true });
    expect(r.append).toBe('append');
    expect(r.clearLoading).toBe(true);
    expect(r.clearUserInterrupted).toBe(true);
  });

  it('non-meaningful messages (assistant) just append with no effects', () => {
    const r = reduceSessionStreamMessage(
      assistantNode([{ type: 'text', text: 'hi' }]),
      baseCtx,
    );
    expect(r.append).toBe('append');
    expect(r.effects).toEqual([]);
    expect(r.pendingPermission).toBeUndefined();
    expect(r.sessionIdUpdate).toBeUndefined();
  });

  describe('activity, metrics, cost', () => {
    it('assistant tool_use updates activity (tool label) and increments toolsExecuted', () => {
      const r = reduceSessionStreamMessage(
        assistantNode([{ type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } }]),
        baseCtx,
      );
      expect(r.activityUpdate).toEqual({ kind: 'literal', label: expect.stringContaining('Searching for') });
      expect(r.metrics.toolsExecuted).toBe(1);
      expect(r.metrics.bumpLastActivity).toBe(true);
    });

    it('assistant tool_use Write counts as filesCreated', () => {
      const r = reduceSessionStreamMessage(
        assistantNode([{ type: 'tool_use', name: 'Write', input: { file_path: '/x.ts' } }]),
        baseCtx,
      );
      expect(r.metrics.toolsExecuted).toBe(1);
      expect(r.metrics.filesCreated).toBe(1);
      expect(r.metrics.filesModified).toBe(0);
    });

    it('assistant tool_use Edit / MultiEdit count as filesModified', () => {
      const r = reduceSessionStreamMessage(
        assistantNode([
          { type: 'tool_use', name: 'Edit', input: { file_path: '/x.ts' } },
          { type: 'tool_use', name: 'MultiEdit', input: { file_path: '/y.ts' } },
        ]),
        baseCtx,
      );
      expect(r.metrics.toolsExecuted).toBe(2);
      expect(r.metrics.filesModified).toBe(2);
    });

    it('assistant thinking block sets a gerund activity', () => {
      const r = reduceSessionStreamMessage(
        assistantNode([{ type: 'thinking', text: 'mm' }]),
        baseCtx,
      );
      expect(r.activityUpdate).toEqual({ kind: 'gerund' });
    });

    it('user tool_result with is_error increments toolsFailed and errorsEncountered', () => {
      const r = reduceSessionStreamMessage(
        userNode([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }]),
        baseCtx,
      );
      expect(r.metrics.toolsFailed).toBe(1);
      expect(r.metrics.errorsEncountered).toBe(1);
      expect(r.activityUpdate).toEqual({ kind: 'gerund' });
    });

    it('assistant text with code fences counts code blocks (closed pairs only)', () => {
      const r = reduceSessionStreamMessage(
        assistantNode([{ type: 'text', text: '```ts\nfoo\n```\n```js\nbar\n```' }]),
        baseCtx,
      );
      expect(r.metrics.codeBlocksGenerated).toBe(2);
    });

    it('system error message increments errorsEncountered', () => {
      const r = reduceSessionStreamMessage(systemErrorNode(), baseCtx);
      expect(r.metrics.errorsEncountered).toBe(1);
    });

    it('assistant usage produces a positive costDelta', () => {
      const node: JsonlNode = {
        kind: 'assistant',
        raw: {
          type: 'assistant',
          sessionId: '',
          timestamp: '2026-05-27T00:00:00Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 1000, output_tokens: 500 },
          },
        } as never,
        sessionId: '',
        receivedAt: '2026-05-27T00:00:00Z',
      };
      const r = reduceSessionStreamMessage(node, baseCtx);
      // 1000 * 0.000003 + 500 * 0.000015 = 0.003 + 0.0075 = 0.0105
      expect(r.costDelta).toBeCloseTo(0.0105, 6);
    });

    it('cli-stream-result usage produces a positive costDelta', () => {
      const node: JsonlNode = {
        kind: 'cli-stream-result',
        raw: { type: 'result', subtype: 'success', usage: { input_tokens: 1000, output_tokens: 500 } } as never,
        sessionId: '',
        receivedAt: '2026-05-27T00:00:00Z',
      };
      const r = reduceSessionStreamMessage(node, baseCtx);
      expect(r.costDelta).toBeCloseTo(0.0105, 6);
    });

    it('messages with no usage produce zero costDelta and an empty metrics delta', () => {
      const r = reduceSessionStreamMessage(compactBoundary(), baseCtx);
      expect(r.costDelta).toBe(0);
      expect(r.metrics).toEqual(EMPTY_METRICS_DELTA);
    });
  });
});

describe('reduceSessionStreamMessage overlay handling', () => {
  it('skips stream-event nodes so they never land in messages[]', () => {
    const result = reduceSessionStreamMessage(
      { kind: 'stream-event', uuid: 'u', deltaText: 'x' },
      {
        projectPath: '/p',
        hasExistingInit: true,
        hasExtractedSession: true,
        userInterrupted: false,
        messagesLength: 0,
      },
    );
    expect(result.append).toBe('skip');
    expect(result.effects).toEqual([]);
    expect(result.metrics).toEqual(EMPTY_METRICS_DELTA);
    expect(result.costDelta).toBe(0);
  });
});
