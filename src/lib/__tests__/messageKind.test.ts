import { describe, it, expect } from 'vitest';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import { classifyStandaloneKind } from '../messageKind';

const sysInit = (): ClaudeStreamMessage =>
  ({ type: 'system', subtype: 'init', session_id: 'abc', model: 'claude', cwd: '/x', tools: [] } as unknown as ClaudeStreamMessage);

const notif = (kind: string): ClaudeStreamMessage =>
  ({ type: 'system', subtype: 'notification', notification_type: kind, body: 'm' } as unknown as ClaudeStreamMessage);

const userText = (text: string): ClaudeStreamMessage =>
  ({ type: 'user', message: { content: [{ type: 'text', text }] } } as unknown as ClaudeStreamMessage);

const permReq = (toolName?: string): ClaudeStreamMessage =>
  ({ type: 'permission_request', tool_name: toolName } as unknown as ClaudeStreamMessage);

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
    expect(classifyStandaloneKind(permReq('Bash'), [])).toBe('permission.request');
    expect(classifyStandaloneKind(resultOk(), [])).toBe('result.success');
    expect(classifyStandaloneKind(summary(), [])).toBe('summary.compaction');
  });

  it('routes AskUserQuestion permission requests to their own kind', () => {
    // Distinct kind so the AskUserQuestionCard's accent color is editable
    // independently of the generic Bash/Read permission prompt.
    expect(classifyStandaloneKind(permReq('AskUserQuestion'), [])).toBe(
      'permission.askUserQuestion',
    );
  });

  it('falls back to permission.request when tool_name is absent', () => {
    expect(classifyStandaloneKind(permReq(undefined), [])).toBe('permission.request');
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

  describe('system.unknown', () => {
    const sys = (subtype: string): ClaudeStreamMessage =>
      ({ type: 'system', subtype } as unknown as ClaudeStreamMessage);

    it('returns system.unknown for an unrecognized system subtype', () => {
      expect(classifyStandaloneKind(sys('compact_boundary'), [])).toBe('system.unknown');
      expect(classifyStandaloneKind(sys('whatever'), [])).toBe('system.unknown');
    });

    it('does not classify init / notification / known hook subtypes as unknown', () => {
      expect(classifyStandaloneKind(sys('init'), [])).toBe('system.init');
      expect(classifyStandaloneKind(sys('hook_started'), [])).toBe('system.hook.started');
      expect(classifyStandaloneKind(sys('hook_response'), [])).toBe('system.hook.response');
      expect(classifyStandaloneKind(sys('user_prompt_submit'), [])).toBe('system.userPromptSubmit');
    });
  });

  describe('user.skillInjection / user.command / user.commandOutput', () => {
    const skillToolUse = (id: string, skill: string): ClaudeStreamMessage =>
      ({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] },
      } as unknown as ClaudeStreamMessage);

    const skillToolResult = (toolUseId: string): ClaudeStreamMessage =>
      ({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'skill body' }] },
      } as unknown as ClaudeStreamMessage);

    it('classifies a user message that follows a Skill tool_result as user.skillInjection', () => {
      const tu = skillToolUse('tu_skill', 'merge-to-main');
      const tr = skillToolResult('tu_skill');
      const injected = userText('# Merge to Main\n...');
      const msgs = [tu, tr, injected];
      expect(classifyStandaloneKind(injected, msgs)).toBe('user.skillInjection');
    });

    it('does not classify as skillInjection when the preceding tool_use was not Skill', () => {
      const tu: ClaudeStreamMessage = {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu_read', name: 'Read', input: {} }] },
      } as unknown as ClaudeStreamMessage;
      const tr = skillToolResult('tu_read');
      const userMsg = userText('plain user message');
      const msgs = [tu, tr, userMsg];
      expect(classifyStandaloneKind(userMsg, msgs)).toBeNull();
    });

    it('classifies a user message wrapped in <command-name>...</command-name> as user.command', () => {
      const cmd = userText('<command-name>/clear</command-name><command-message>Clear context</command-message><command-args></command-args>');
      expect(classifyStandaloneKind(cmd, [cmd])).toBe('user.command');
    });

    it('classifies a user message wrapped in <local-command-stdout>...</local-command-stdout> as user.commandOutput', () => {
      const out = userText('<local-command-stdout>some output</local-command-stdout>');
      expect(classifyStandaloneKind(out, [out])).toBe('user.commandOutput');
    });

    it('returns null for a plain user prompt that does not match any pattern', () => {
      expect(classifyStandaloneKind(userText('regular prompt'), [])).toBeNull();
    });
  });

  describe('user.systemContext (whole-message)', () => {
    // The Agent SDK delivers hook output and other system injections as
    // synthetic user-role messages. Without whole-message classification
    // these fall through to user.prompt and render as if the user typed
    // them — which is what the OmniFex chat was doing for Stop-hook
    // feedback before this fix.

    it('classifies a bare "Stop hook feedback:" user message as user.systemContext', () => {
      const m = userText(
        'Stop hook feedback:\nYou have 2 unfinished todo items in your latest TodoWrite call:\n  - [pending] foo\n  - [pending] bar',
      );
      expect(classifyStandaloneKind(m, [m])).toBe('user.systemContext');
    });

    it('classifies a user message wrapping a <system-reminder> block as user.systemContext', () => {
      const m = userText('<system-reminder>\nrouted context\n</system-reminder>');
      expect(classifyStandaloneKind(m, [m])).toBe('user.systemContext');
    });

    it('classifies a Stop-hook message containing both a <system-reminder> preamble and hook feedback body', () => {
      // This is the exact shape seen in OmniFex sessions: the hook content
      // is wrapped in a <system-reminder>, then followed by a plain
      // "Stop hook feedback: ..." body in the same text block.
      const m = userText(
        '<system-reminder>\nStop hook blocking error from command: "..."/check-unfinished-todos.py: You have 4 unfinished todo items...\n</system-reminder>\nStop hook feedback:\nYou have 4 unfinished todo items in your latest TodoWrite call:\n  - [in_progress] X\n',
      );
      expect(classifyStandaloneKind(m, [m])).toBe('user.systemContext');
    });

    it('classifies SessionStart additional-context preamble as user.systemContext', () => {
      const m = userText(
        'SessionStart hook additional context: <EXTREMELY_IMPORTANT>...</EXTREMELY_IMPORTANT>',
      );
      expect(classifyStandaloneKind(m, [m])).toBe('user.systemContext');
    });

    it('classifies PreToolUse / PostToolUse / UserPromptSubmit / SubagentStop / Notification feedback as user.systemContext', () => {
      for (const prefix of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SubagentStop', 'Notification']) {
        const m = userText(`${prefix} hook feedback:\nblocked because reasons`);
        expect(classifyStandaloneKind(m, [m]), `prefix=${prefix}`).toBe('user.systemContext');
      }
    });

    it('does NOT classify a plain user-typed message mentioning hook feedback mid-line', () => {
      const m = userText('I read about Stop hook feedback: in the docs and have a question.');
      expect(classifyStandaloneKind(m, [m])).toBeNull();
    });
  });
});

