import { describe, it, expect } from 'vitest';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import { classifyStandaloneKind, filterCompactHidden } from '../messageKind';
import { createDefaultConfig } from '../messageRenderingConfig';

const sysInit = (): ClaudeStreamMessage =>
  ({ type: 'system', subtype: 'init', session_id: 'abc', model: 'claude', cwd: '/x', tools: [] } as unknown as ClaudeStreamMessage);

const notif = (kind: string): ClaudeStreamMessage =>
  ({ type: 'system', subtype: 'notification', notification_type: kind, message: 'm' } as unknown as ClaudeStreamMessage);

const userText = (text: string): ClaudeStreamMessage =>
  ({ type: 'user', message: { content: [{ type: 'text', text }] } } as unknown as ClaudeStreamMessage);

const permReq = (): ClaudeStreamMessage =>
  ({ type: 'permission_request' } as unknown as ClaudeStreamMessage);

const resultOk = (): ClaudeStreamMessage =>
  ({ type: 'result', subtype: 'success', result: 'hi' } as unknown as ClaudeStreamMessage);

const resultErr = (): ClaudeStreamMessage =>
  ({ type: 'result', subtype: 'error', result: 'boom', is_error: true } as unknown as ClaudeStreamMessage);

const summary = (): ClaudeStreamMessage =>
  ({ type: 'summary', leafUuid: 'leaf-1', summary: 'sum' } as unknown as ClaudeStreamMessage);

const agentToolUse = (
  id: string,
  name: 'Agent' | 'Task' = 'Agent',
  runInBackground = false,
): ClaudeStreamMessage =>
  ({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id,
          name,
          input: {
            description: 'verify',
            ...(runInBackground ? { run_in_background: true } : {}),
          },
        },
      ],
    },
  } as unknown as ClaudeStreamMessage);

const toolResult = (toolUseId: string, isError = false): ClaudeStreamMessage =>
  ({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: 'ok' },
      ],
    },
  } as unknown as ClaudeStreamMessage);

describe('classifyStandaloneKind', () => {
  it('tags system init', () => {
    expect(classifyStandaloneKind(sysInit(), [])).toBe('system.init');
  });

  it('tags notification subtypes by notification_type', () => {
    expect(classifyStandaloneKind(notif('error'), [])).toBe('system.notification.error');
    expect(classifyStandaloneKind(notif('stop'), [])).toBe('system.notification.stop');
    expect(classifyStandaloneKind(notif('warn'), [])).toBe('system.notification.warn');
    expect(classifyStandaloneKind(notif('info'), [])).toBe('system.notification.info');
    // Unknown → info fallback, matching StreamMessage rendering
    expect(classifyStandaloneKind(notif('whatever'), [])).toBe('system.notification.info');
  });

  it('tags permission requests, results, summaries', () => {
    expect(classifyStandaloneKind(permReq(), [])).toBe('permission.request');
    expect(classifyStandaloneKind(resultOk(), [])).toBe('result.success');
    expect(classifyStandaloneKind(summary(), [])).toBe('summary.compaction');
  });

  describe('result.awaiting_background (sibling of result.success)', () => {
    it('returns result.awaiting_background when a turn ends with a still-running Agent dispatch', () => {
      const r = resultOk();
      const msgs = [agentToolUse('toolu_1', 'Agent'), r];
      expect(classifyStandaloneKind(r, msgs)).toBe('result.awaiting_background');
    });

    it('returns result.awaiting_background for a Task tool_use with no tool_result yet', () => {
      const r = resultOk();
      const msgs = [agentToolUse('toolu_2', 'Task'), r];
      expect(classifyStandaloneKind(r, msgs)).toBe('result.awaiting_background');
    });

    it('returns plain result.success when the subagent already returned a tool_result', () => {
      const r = resultOk();
      const msgs = [agentToolUse('toolu_3', 'Agent'), toolResult('toolu_3', false), r];
      expect(classifyStandaloneKind(r, msgs)).toBe('result.success');
    });

    it('still returns result.error when the turn errored, even with running subagent', () => {
      const r = resultErr();
      const msgs = [agentToolUse('toolu_4', 'Agent'), r];
      expect(classifyStandaloneKind(r, msgs)).toBe('result.error');
    });

    it('returns plain result.success when no Agent/Task dispatch happened in the turn', () => {
      const r = resultOk();
      const msgs = [r];
      expect(classifyStandaloneKind(r, msgs)).toBe('result.success');
    });

    it('Bash run_in_background dispatch + ACK + result.success classifies as awaiting (the npm run make case)', () => {
      // The realistic shape from /greychrist-release: I dispatch `Bash` with
      // run_in_background:true to build the DMG, the SDK fires the immediate
      // ACK tool_result, and my parent turn ends. The result event must
      // classify as awaiting_background even though the tool name is Bash,
      // not Agent/Task — Greg's "I always see one when running release" memory.
      const r = resultOk();
      const bashBg: ClaudeStreamMessage = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_bash_bg',
              name: 'Bash',
              input: {
                command: 'npm run make',
                description: 'Build DMG + ZIP',
                run_in_background: true,
              },
            },
          ],
        },
      } as unknown as ClaudeStreamMessage;
      const msgs = [bashBg, toolResult('toolu_bash_bg', false), r];
      expect(classifyStandaloneKind(r, msgs)).toBe('result.awaiting_background');
    });

    it('background dispatch with synchronous ACK tool_result still classifies as awaiting', () => {
      // The realistic shape: SDK emits an immediate ACK tool_result for a
      // run_in_background:true dispatch ("Async agent launched..."). Without
      // the deriveSubagents fix, the ACK flips status to completed and the
      // result classifies as plain success — which is the bug Greg saw.
      const r = resultOk();
      const msgs = [
        agentToolUse('toolu_bg1', 'Agent', true),
        // ACK tool_result (is_error: false). Body content irrelevant — what
        // matters is that the SDK fires it before the actual subagent returns.
        toolResult('toolu_bg1', false),
        r,
      ];
      expect(classifyStandaloneKind(r, msgs)).toBe('result.awaiting_background');
    });

    it('only counts subagents dispatched before this result, not after', () => {
      // Two result events: first should be a clean success (no prior dispatch);
      // second should be awaiting (Agent dispatched between them).
      const r1 = resultOk();
      const r2 = resultOk();
      const msgs = [r1, agentToolUse('toolu_5', 'Agent'), r2];
      expect(classifyStandaloneKind(r1, msgs)).toBe('result.success');
      expect(classifyStandaloneKind(r2, msgs)).toBe('result.awaiting_background');
    });
  });

  it('returns null for messages whose rendering is per-content-block', () => {
    // Assistant / user messages can contain mixed blocks; filtering them as a
    // whole would hide text along with tool_use. Leave to existing renderer.
    const asst: ClaudeStreamMessage = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read', input: {} }] },
    } as unknown as ClaudeStreamMessage;
    expect(classifyStandaloneKind(asst, [])).toBeNull();
    expect(classifyStandaloneKind(userText('hello'), [])).toBeNull();
  });
});

describe('filterCompactHidden', () => {
  it('drops system.init when hiddenInCompact=true (default)', () => {
    const cfg = createDefaultConfig();
    expect(cfg.kinds['system.init'].hiddenInCompact).toBe(true);
    const msgs = [userText('hi'), sysInit(), userText('bye')];
    const filtered = filterCompactHidden(msgs, cfg);
    expect(filtered).toHaveLength(2);
    expect(filtered.every(m => !(m.type === 'system' && m.subtype === 'init'))).toBe(true);
  });

  it('keeps system.init when hiddenInCompact=false', () => {
    const cfg = createDefaultConfig();
    cfg.kinds['system.init'] = { ...cfg.kinds['system.init'], hiddenInCompact: false };
    const msgs = [sysInit()];
    expect(filterCompactHidden(msgs, cfg)).toHaveLength(1);
  });

  it('never drops compact-boundary-locked kinds regardless of hiddenInCompact', () => {
    const cfg = createDefaultConfig();
    // Force the flag on; mergeConfig normally prevents this, but defense-in-depth.
    cfg.kinds['permission.request'] = { ...cfg.kinds['permission.request'], hiddenInCompact: true };
    cfg.kinds['result.success'] = { ...cfg.kinds['result.success'], hiddenInCompact: true };
    const msgs = [permReq(), resultOk(), summary()];
    expect(filterCompactHidden(msgs, cfg)).toHaveLength(3);
  });

  it('drops info notifications by default, keeps error/warn/stop', () => {
    const cfg = createDefaultConfig();
    const msgs = [notif('info'), notif('error'), notif('warn'), notif('stop')];
    const filtered = filterCompactHidden(msgs, cfg);
    expect(filtered).toHaveLength(3);
    expect(filtered.every((m) => (m as { notification_type?: string }).notification_type !== 'info')).toBe(true);
  });

  it('leaves unclassifiable messages alone', () => {
    const cfg = createDefaultConfig();
    const msgs = [userText('hi'), sysInit()];
    const filtered = filterCompactHidden(msgs, cfg);
    expect(filtered).toContainEqual(msgs[0]);
  });
});
