import { describe, it, expect } from 'vitest';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
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

const sysInit = (sessionId = 'sess-1'): ClaudeStreamMessage =>
  ({ type: 'system', subtype: 'init', session_id: sessionId } as ClaudeStreamMessage);

const compactBoundary = (): ClaudeStreamMessage =>
  ({ type: 'system', subtype: 'compact_boundary' } as ClaudeStreamMessage);

const permissionRequest = (): ClaudeStreamMessage =>
  ({
    type: 'permission_request',
    request_id: 'perm-1',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    title: 'Run ls',
    display_name: 'Bash',
    description: 'list files',
    decision_reason: 'project rules',
    permission_suggestions: [{ type: 'addRules', rules: [], behavior: 'allow' }],
  } as unknown as ClaudeStreamMessage);

const resultOk = (): ClaudeStreamMessage =>
  ({ type: 'result', subtype: 'success', result: 'ok' } as ClaudeStreamMessage);

const resultErr = (): ClaudeStreamMessage =>
  ({ type: 'result', subtype: 'error', is_error: true, result: 'boom' } as unknown as ClaudeStreamMessage);

describe('reduceSessionStreamMessage', () => {
  it('permission_request produces pending permission state and showPermissionPrompt effect', () => {
    const r = reduceSessionStreamMessage(permissionRequest(), baseCtx);
    expect(r.append).toBe('append');
    expect(r.pendingPermission).toMatchObject({
      requestId: 'perm-1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      title: 'Run ls',
      displayName: 'Bash',
      description: 'list files',
      decisionReason: 'project rules',
    });
    expect(r.pendingPermission?.suggestions).toHaveLength(1);
    expect(r.effects).toContainEqual(
      expect.objectContaining({ kind: 'showPermissionPrompt' }),
    );
  });

  it('system:init with new session id produces sessionIdUpdate, extractedSessionInfo, and fetch effects', () => {
    const r = reduceSessionStreamMessage(sysInit('new-sess'), {
      ...baseCtx,
      messagesLength: 3,
    });
    expect(r.sessionIdUpdate).toBe('new-sess');
    expect(r.extractedSessionInfo).toEqual({
      sessionId: 'new-sess',
      // Same projectId derivation as the original component
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
    // Re-extracts the live session id (matches existing component behavior)
    expect(r.sessionIdUpdate).toBe('same-sess');
    // Already-extracted session: do not save persistence again
    expect(r.extractedSessionInfo).toBeUndefined();
    expect(r.effects.find((e) => e.kind === 'saveSessionPersistence')).toBeUndefined();
    // Live SDK info fetches still fire on every init (e.g. after rebind)
    const kinds = r.effects.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'fetchAccountInfo',
        'refreshContextUsage',
        'fetchSupportedModels',
      ]),
    );
  });

  it('result message clears loading and requests context usage refresh + queued prompt drain', () => {
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
    // Suppressed: no context refresh, no queued-prompt processing
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

  it('non-meaningful messages (assistant) just append with no effects', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
    } as unknown as ClaudeStreamMessage;
    const r = reduceSessionStreamMessage(msg, baseCtx);
    expect(r.append).toBe('append');
    expect(r.effects).toEqual([]);
    expect(r.pendingPermission).toBeUndefined();
    expect(r.sessionIdUpdate).toBeUndefined();
  });

  describe('activity, metrics, cost', () => {
    it('assistant tool_use updates activity (tool label) and increments toolsExecuted', () => {
      const msg = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
          ],
        },
      } as unknown as ClaudeStreamMessage;
      const r = reduceSessionStreamMessage(msg, baseCtx);
      expect(r.activityUpdate).toEqual({ kind: 'literal', label: expect.stringContaining('Searching for') });
      expect(r.metrics.toolsExecuted).toBe(1);
      expect(r.metrics.bumpLastActivity).toBe(true);
    });

    it('assistant tool_use Write counts as filesCreated', () => {
      const msg = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/x.ts' } },
          ],
        },
      } as unknown as ClaudeStreamMessage;
      const r = reduceSessionStreamMessage(msg, baseCtx);
      expect(r.metrics.toolsExecuted).toBe(1);
      expect(r.metrics.filesCreated).toBe(1);
      expect(r.metrics.filesModified).toBe(0);
    });

    it('assistant tool_use Edit / MultiEdit count as filesModified', () => {
      const msg = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/x.ts' } },
            { type: 'tool_use', name: 'MultiEdit', input: { file_path: '/y.ts' } },
          ],
        },
      } as unknown as ClaudeStreamMessage;
      const r = reduceSessionStreamMessage(msg, baseCtx);
      expect(r.metrics.toolsExecuted).toBe(2);
      expect(r.metrics.filesModified).toBe(2);
    });

    it('assistant thinking block sets a gerund activity', () => {
      const msg = {
        type: 'assistant',
        message: { content: [{ type: 'thinking', text: 'mm' }] },
      } as unknown as ClaudeStreamMessage;
      const r = reduceSessionStreamMessage(msg, baseCtx);
      expect(r.activityUpdate).toEqual({ kind: 'gerund' });
    });

    it('user tool_result with is_error increments toolsFailed and errorsEncountered', () => {
      const msg = {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' },
          ],
        },
      } as unknown as ClaudeStreamMessage;
      const r = reduceSessionStreamMessage(msg, baseCtx);
      expect(r.metrics.toolsFailed).toBe(1);
      expect(r.metrics.errorsEncountered).toBe(1);
      expect(r.activityUpdate).toEqual({ kind: 'gerund' });
    });

    it('assistant text with code fences counts code blocks (closed pairs only)', () => {
      const msg = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '```ts\nfoo\n```\n```js\nbar\n```' },
          ],
        },
      } as unknown as ClaudeStreamMessage;
      const r = reduceSessionStreamMessage(msg, baseCtx);
      expect(r.metrics.codeBlocksGenerated).toBe(2);
    });

    it('system error message increments errorsEncountered', () => {
      const msg = {
        type: 'system',
        subtype: 'error',
        message: 'oops',
      } as unknown as ClaudeStreamMessage;
      const r = reduceSessionStreamMessage(msg, baseCtx);
      expect(r.metrics.errorsEncountered).toBe(1);
    });

    it('assistant usage produces a positive costDelta', () => {
      const msg = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
      } as unknown as ClaudeStreamMessage;
      const r = reduceSessionStreamMessage(msg, baseCtx);
      // 1000 * 0.000003 + 500 * 0.000015 = 0.003 + 0.0075 = 0.0105
      expect(r.costDelta).toBeCloseTo(0.0105, 6);
    });

    it('messages with no usage produce zero costDelta and an empty metrics delta', () => {
      const msg = {
        type: 'system',
        subtype: 'compact_boundary',
      } as unknown as ClaudeStreamMessage;
      const r = reduceSessionStreamMessage(msg, baseCtx);
      expect(r.costDelta).toBe(0);
      expect(r.metrics).toEqual(EMPTY_METRICS_DELTA);
    });
  });
});

describe('reduceSessionStreamMessage stream_event handling', () => {
  it('skips stream_event messages so they never land in messages[]', () => {
    const result = reduceSessionStreamMessage(
      // Cast — stream_event isn't in the local ClaudeStreamMessage union;
      // the reducer's case branch handles it defensively.
      { type: 'stream_event', uuid: 'u', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } } as any,
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
