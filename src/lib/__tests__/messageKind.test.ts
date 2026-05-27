import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { classifyStandaloneKind } from '../messageKind';

const sysInit = (): JsonlNode =>
  ({ kind: 'system', subtype: 'init', sessionId: '', receivedAt: '', raw: { type: 'system', subtype: 'init', session_id: 'abc', model: 'claude', cwd: '/x' } }) as unknown as JsonlNode;

const notif = (kind: string): JsonlNode =>
  ({ kind: 'system', subtype: 'notification', sessionId: '', receivedAt: '', raw: { type: 'system', subtype: 'notification', notification_type: kind, body: 'm' } }) as unknown as JsonlNode;

const userText = (text: string): JsonlNode =>
  ({ kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } } }) as unknown as JsonlNode;

const permReq = (toolName?: string): JsonlNode =>
  ({ kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'permission_request', tool_name: toolName } }) as unknown as JsonlNode;

const resultOk = (): JsonlNode =>
  ({ kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', result: 'hi' } }) as unknown as JsonlNode;

const resultErr = (): JsonlNode =>
  ({ kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'error', result: 'boom', is_error: true } }) as unknown as JsonlNode;

const summary = (): JsonlNode =>
  ({ kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'summary', leafUuid: 'leaf-1', summary: 'sum' } }) as unknown as JsonlNode;

const agentToolUse = (
  id: string,
  name: 'Agent' | 'Task' = 'Agent',
  runInBackground = false,
): JsonlNode =>
  ({
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
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
    },
  }) as unknown as JsonlNode;

const toolResult = (toolUseId: string, isError = false): JsonlNode =>
  ({
    kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '',
    raw: {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: 'ok' },
        ],
      },
    },
  }) as unknown as JsonlNode;

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

  it('classifies an error result as result.error_during_execution', () => {
    expect(classifyStandaloneKind(resultErr(), [resultErr()])).toBe('result.error_during_execution');
  });

  describe('result.error_during_execution gating: only on is_error===true', () => {
    // Regression: the previous predicate was `subtype.includes('error')`, which
    // false-positived on benign SDK subtypes (e.g. a transient result event
    // whose subtype string contained "error" but whose is_error was false /
    // absent). The SDK canonical signal is is_error: true; we should rely on
    // that exclusively. Both real error subtypes (error_max_turns and
    // error_during_execution) carry is_error: true, so this loses no signal.
    it('does NOT classify error_max_turns without is_error as result.error_during_execution', () => {
      const r = { kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'error_max_turns', result: '' } } as unknown as JsonlNode;
      expect(classifyStandaloneKind(r, [r])).not.toBe('result.error_during_execution');
    });

    it('does NOT classify error_during_execution without is_error as result.error_during_execution', () => {
      const r = { kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'error_during_execution', result: '' } } as unknown as JsonlNode;
      expect(classifyStandaloneKind(r, [r])).not.toBe('result.error_during_execution');
    });

    it('DOES classify a result with is_error: true as result.error_during_execution regardless of subtype', () => {
      const r = { kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'success', is_error: true, result: 'boom' } } as unknown as JsonlNode;
      expect(classifyStandaloneKind(r, [r])).toBe('result.error_during_execution');
    });

    it('DOES classify error_max_turns WITH is_error: true as result.error_during_execution', () => {
      const r = { kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'result', subtype: 'error_max_turns', is_error: true, result: '' } } as unknown as JsonlNode;
      expect(classifyStandaloneKind(r, [r])).toBe('result.error_during_execution');
    });
  });

  it('routes AskUserQuestion permission requests to their own kind', () => {
    // Distinct kind so the AskUserQuestionCard's accent color is editable
    // independently of the generic Bash/Read permission prompt.
    expect(classifyStandaloneKind(permReq('AskUserQuestion'), [])).toBe(
      'permission.askUserQuestion',
    );
  });

  describe('AskUserQuestion answered-pair elevation', () => {
    // Once an AskUserQuestion exchange has completed (tool_use + matching
    // tool_result both in the stream), the renderer pulls the Q+A card
    // out of the assistant bubble and shows it as its own first-order
    // chat message. The classifier returns separate kinds for each side
    // so the renderer can dispatch — assistant side renders the card,
    // user side returns null.

    const askUserQuestion = (id: string): JsonlNode =>
      ({
        kind: 'assistant', sessionId: '', receivedAt: '',
        raw: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id,
                name: 'AskUserQuestion',
                input: { questions: [{ question: 'Pick', options: [{ label: 'A' }] }] },
              },
            ],
          },
        },
      }) as unknown as JsonlNode;

    const askUserQuestionResult = (toolUseId: string): JsonlNode =>
      ({
        kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '',
        raw: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: 'User has answered your questions: "Pick"="A". You can now continue with the user\'s answers in mind.',
              },
            ],
          },
        },
      }) as unknown as JsonlNode;

    it('classifies the assistant message as tool.askUserQuestion.answered once the tool_result has landed', () => {
      const tu = askUserQuestion('toolu_AUQ');
      const tr = askUserQuestionResult('toolu_AUQ');
      expect(classifyStandaloneKind(tu, [tu, tr])).toBe('tool.askUserQuestion.answered');
    });

    it('classifies the paired user message as tool.askUserQuestion.answered.result', () => {
      const tu = askUserQuestion('toolu_AUQ');
      const tr = askUserQuestionResult('toolu_AUQ');
      expect(classifyStandaloneKind(tr, [tu, tr])).toBe('tool.askUserQuestion.answered.result');
    });

    it('does NOT elevate while the tool_result is still pending (live mid-answer state)', () => {
      // While the user is still answering, the live AskUserQuestionCard
      // (rendered from the synthetic permission_request) is doing the
      // visible work. The assistant message stays unclassified so the
      // in-bubble fallback path handles it.
      const tu = askUserQuestion('toolu_AUQ');
      expect(classifyStandaloneKind(tu, [tu])).toBeNull();
    });

    it('does NOT elevate when the assistant message has other renderable content alongside the tool_use', () => {
      // Mixed content — text or thinking blocks — should keep the
      // in-bubble rendering so the prose isn't lost.
      const mixed = {
        kind: 'assistant', sessionId: '', receivedAt: '',
        raw: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me ask you something.' },
              {
                type: 'tool_use',
                id: 'toolu_AUQ',
                name: 'AskUserQuestion',
                input: { questions: [{ question: 'q', options: [{ label: 'a' }] }] },
              },
            ],
          },
        },
      } as unknown as JsonlNode;
      const tr = askUserQuestionResult('toolu_AUQ');
      expect(classifyStandaloneKind(mixed, [mixed, tr])).toBeNull();
    });

    it('does NOT classify a user tool_result whose matching tool_use was not AskUserQuestion', () => {
      const readToolUse = {
        kind: 'assistant', sessionId: '', receivedAt: '',
        raw: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_R', name: 'Read', input: {} }] },
        },
      } as unknown as JsonlNode;
      const tr = askUserQuestionResult('toolu_R');
      expect(classifyStandaloneKind(tr, [readToolUse, tr])).toBeNull();
    });

    it('ignores empty text blocks when checking single-block elevation', () => {
      // The SDK sometimes precedes a tool_use with an empty text block.
      // It shouldn't disqualify the assistant message from elevation.
      const withEmptyText = {
        kind: 'assistant', sessionId: '', receivedAt: '',
        raw: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: '' },
              {
                type: 'tool_use',
                id: 'toolu_AUQ',
                name: 'AskUserQuestion',
                input: { questions: [{ question: 'q', options: [{ label: 'a' }] }] },
              },
            ],
          },
        },
      } as unknown as JsonlNode;
      const tr = askUserQuestionResult('toolu_AUQ');
      expect(classifyStandaloneKind(withEmptyText, [withEmptyText, tr])).toBe(
        'tool.askUserQuestion.answered',
      );
    });
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

    it('still returns result.error_during_execution when the turn errored, even with running subagent', () => {
      const r = resultErr();
      const msgs = [agentToolUse('toolu_4', 'Agent'), r];
      expect(classifyStandaloneKind(r, msgs)).toBe('result.error_during_execution');
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
      const bashBg: JsonlNode = {
        kind: 'assistant', sessionId: '', receivedAt: '',
        raw: {
          type: 'assistant',
          message: {
            role: 'assistant',
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
        },
      } as unknown as JsonlNode;
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
    const asst: JsonlNode = {
      kind: 'assistant', sessionId: '', receivedAt: '',
      raw: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read', input: {} }] },
      },
    } as unknown as JsonlNode;
    expect(classifyStandaloneKind(asst, [])).toBeNull();
    expect(classifyStandaloneKind(userText('hello'), [])).toBeNull();
  });

  describe('system.unknown', () => {
    const sys = (subtype: string): JsonlNode =>
      ({ kind: 'system', subtype, sessionId: '', receivedAt: '', raw: { type: 'system', subtype } }) as unknown as JsonlNode;

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

  describe('system.permission_denied', () => {
    // SDKPermissionDeniedMessage (`type: 'system', subtype: 'permission_denied'`)
    // is emitted when a tool call is auto-denied without an interactive
    // permission prompt (auto-mode classifier, dontAsk mode, headless-agent
    // auto-deny, or a deny rule). Until this kind was first-classed it
    // fell through to `system.unknown` and rendered as a small gray inline
    // strip — same treatment as a no-op telemetry event. Auto-deny is a
    // user-facing action that needs distinct visual weight.
    const sys = (extras: Record<string, unknown>): JsonlNode =>
      ({
        kind: 'system', subtype: 'permission_denied', sessionId: '', receivedAt: '',
        raw: { type: 'system', subtype: 'permission_denied', ...extras },
      }) as unknown as JsonlNode;

    it('classifies the SDK auto-deny shape as system.permission_denied', () => {
      expect(
        classifyStandaloneKind(
          sys({ tool_name: 'Bash', tool_use_id: 'tu_1', message: 'denied by deny rule' }),
          [],
        ),
      ).toBe('system.permission_denied');
    });

    it('classifies the OmniFex hook synthetic shape as system.permission_denied', () => {
      // `electron/services/sessions/hooks.ts:355` emits its own
      // `system + permission_denied` row when the OmniFex PermissionDenied
      // hook fires. Different field shape (`reason` instead of `message`)
      // but the same kind classification — both are auto-deny events.
      expect(
        classifyStandaloneKind(
          sys({ tool_name: 'Edit', reason: 'blocked by user rule' }),
          [],
        ),
      ).toBe('system.permission_denied');
    });
  });

  describe('user.skillInjection / user.command / user.commandOutput', () => {
    const skillToolUse = (id: string, skill: string): JsonlNode =>
      ({
        kind: 'assistant', sessionId: '', receivedAt: '',
        raw: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] },
        },
      }) as unknown as JsonlNode;

    const skillToolResult = (toolUseId: string): JsonlNode =>
      ({
        kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '',
        raw: {
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'skill body' }] },
        },
      }) as unknown as JsonlNode;

    it('classifies a user message that follows a Skill tool_result as user.skillInjection', () => {
      const tu = skillToolUse('tu_skill', 'merge-to-main');
      const tr = skillToolResult('tu_skill');
      const injected = userText('# Merge to Main\n...');
      const msgs = [tu, tr, injected];
      expect(classifyStandaloneKind(injected, msgs)).toBe('user.skillInjection');
    });

    it('does not classify as skillInjection when the preceding tool_use was not Skill', () => {
      const tu: JsonlNode = {
        kind: 'assistant', sessionId: '', receivedAt: '',
        raw: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_read', name: 'Read', input: {} }] },
        },
      } as unknown as JsonlNode;
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

