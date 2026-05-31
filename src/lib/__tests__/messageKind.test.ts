import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { classifyStandaloneKind } from '../messageKind';

const attachment = (subtype?: string): JsonlNode =>
  ({ kind: 'attachment', sessionId: '', receivedAt: '', raw: { type: 'attachment', attachment: subtype ? { type: subtype } : {} } }) as unknown as JsonlNode;

const notif = (kind: string): JsonlNode =>
  ({ kind: 'system', subtype: 'notification', sessionId: '', receivedAt: '', raw: { type: 'system', subtype: 'notification', notification_type: kind, body: 'm' } }) as unknown as JsonlNode;

const userText = (text: string): JsonlNode =>
  ({ kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } } }) as unknown as JsonlNode;

const permReq = (toolName?: string): JsonlNode =>
  ({ kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'permission_request', tool_name: toolName } }) as unknown as JsonlNode;

const summary = (): JsonlNode =>
  ({ kind: 'unknown', sessionId: '', receivedAt: '', raw: { type: 'summary', leafUuid: 'leaf-1', summary: 'sum' } }) as unknown as JsonlNode;

describe('classifyStandaloneKind', () => {
  it('tags notification subtypes by notification_type', () => {
    expect(classifyStandaloneKind(notif('error'), [])).toBe('system.notification.error');
    expect(classifyStandaloneKind(notif('stop'), [])).toBe('system.notification.stop');
    expect(classifyStandaloneKind(notif('warn'), [])).toBe('system.notification.warn');
    expect(classifyStandaloneKind(notif('info'), [])).toBe('system.notification.info');
    // Unknown → info fallback, matching StreamMessage rendering
    expect(classifyStandaloneKind(notif('whatever'), [])).toBe('system.notification.info');
  });

  it('tags permission requests and summaries', () => {
    expect(classifyStandaloneKind(permReq('Bash'), [])).toBe('permission.request');
    expect(classifyStandaloneKind(summary(), [])).toBe('summary.compaction');
  });

  it('routes the live AskUserQuestion prompt to its own kind', () => {
    // Distinct kind so the AskUserQuestionCard's accent color is editable
    // independently of the generic Bash/Read permission prompt. (Only the
    // *answered* card is recategorized to the agent origin — the live prompt
    // is left under permission.*.)
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
      // The CLI sometimes precedes a tool_use with an empty text block.
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

    it('does not classify notification / known hook subtypes as unknown', () => {
      expect(classifyStandaloneKind(sys('hook_started'), [])).toBe('system.hook_started');
      expect(classifyStandaloneKind(sys('hook_response'), [])).toBe('system.hook_response');
      expect(classifyStandaloneKind(sys('user_prompt_submit'), [])).toBe('system.userPromptSubmit');
    });

    it('routes system.init to system.unknown (cli-stream-init intercepts init before this branch)', () => {
      // The cli-stream-init classifier handles the `system:init` envelope at
      // classifyJsonlLine time. If a system node with subtype 'init' somehow
      // reaches classifyStandaloneKind, it falls through to system.unknown —
      // the dedicated system.init catalog row was deleted.
      expect(classifyStandaloneKind(sys('init'), [])).toBe('system.unknown');
    });
  });

  describe('system.permission_denied', () => {
    // CliPermissionDeniedMessage (`type: 'system', subtype: 'permission_denied'`)
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

    it('classifies the CLI auto-deny shape as system.permission_denied', () => {
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

  describe('attachment subtype routing', () => {
    it('routes attachment with todo_reminder subtype', () => {
      expect(classifyStandaloneKind(attachment('todo_reminder'), [])).toBe('attachment.todo_reminder');
    });

    it('routes attachment with hook_blocking_error subtype', () => {
      expect(classifyStandaloneKind(attachment('hook_blocking_error'), [])).toBe('attachment.hook_blocking_error');
    });

    it('routes attachment with any string subtype to attachment.<subtype> (open-ended)', () => {
      // The classifier always produces attachment.<subtype> for any non-empty string.
      // Catalog lookup for unknown subtypes falls through to the attachment.unknown row.
      expect(classifyStandaloneKind(attachment('something_new'), [])).toBe('attachment.something_new');
    });

    it('routes attachment with no subtype to attachment.unknown', () => {
      expect(classifyStandaloneKind(attachment(undefined), [])).toBe('attachment.unknown');
    });

    it('routes attachment with file subtype', () => {
      expect(classifyStandaloneKind(attachment('file'), [])).toBe('attachment.file');
    });
  });

  describe('user.systemContext (whole-message)', () => {
    // The CLI delivers hook output and other system injections as
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

