import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { classifyStandaloneKind } from '../messageKind';
import { KIND_REGISTRY } from '@/lib/messageRenderingConfig';

const EMITTABLE_IDS = [
  "assistant.text", "assistant.text.endTurn", "assistant.thinking",
  "assistant.tool-use", "assistant.askUserQuestion",
  "user.prompt", "user.command", "user.commandOutput", "user.subagentPrompt",
  "user.skillInjection", "user.systemContext", "user.sdkSystemBracket",
  "user.taskNotification", "user.coordinatorMessage",
  "user.tool-result", "user.tool-result.image", "user.image",
  "user.compactSummary",
  "system.notification.info", "system.notification.warn",
  "system.notification.error", "system.notification.stop",
  "system.hook_started", "system.hook_response", "system.hook_progress", "system.permission_denied",
  "system.userPromptSubmit", "system.api_error", "system.away_summary",
  "system.thinking_tokens", "system.rate_limit", "system.feedback_draft_queued",
  "system.local_command", "system.stop_hook_summary", "system.unknown",
  "system.compact_boundary", "system.result", "system.init", "system.progress",
  "system.background_tasks_changed", "system.dev_intent",
  "system.per_turn_effort_changed", "system.elicitation_complete",
  "system.session_metadata", "system.session_title_changed",
  "system.ui_invalidate", "system.ui_focus", "system.ui_panes", "system.ui_placed",
  "system.ui_scroll", "system.ui_status", "system.commands_changed",
  "system.ui_notify", "system.ui_notify_cancel",
  "system.permission_check_status", "system.status",
  "system.ui_log", "system.ui_toast",
  "permission.request", "permission.askUserQuestion",
  "summary.compaction", "unknown",
  "permission-mode", "last-prompt", "ai-title", "custom-title",
  "queue-operation", "file-history-snapshot",
  "control.effort", "control.model", "control.permission",
  "assistant.text.live",
  "attachment.instructions", "attachment.nested_memory",
  "attachment.mcp_instructions_delta", "attachment.agent_listing_delta",
  "attachment.deferred_tools_delta", "attachment.skill_listing", "attachment.project_doc_reads",
  "cli-state",
  "task-lifecycle",
];

describe('classifier ↔ registry coverage', () => {
  it('every emittable kind id is registered', () => {
    for (const id of EMITTABLE_IDS) expect(KIND_REGISTRY[id], id).toBeDefined();
  });

  it('no registry id is dead weight (all are in the emittable set)', () => {
    for (const id of Object.keys(KIND_REGISTRY)) expect(EMITTABLE_IDS, id).toContain(id);
  });
});

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

// The CLI stamps every user record's origin: `human`, `task-notification`,
// `coordinator`.
const originUser = (kind: string, text: string, extra: Record<string, unknown> = {}): JsonlNode =>
  ({
    kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '',
    raw: {
      type: 'user',
      origin: { kind },
      message: { role: 'user', content: [{ type: 'text', text }] },
      ...extra,
    },
  }) as unknown as JsonlNode;

describe('classifyStandaloneKind — injected user records (origin.kind)', () => {
  it('classifies a background task notification as its own kind, not a prompt', () => {
    const node = originUser(
      'task-notification',
      '<task-notification>\n<task-id>bsj2w52p4</task-id>\n<status>completed</status>\n</task-notification>',
      { promptSource: 'sdk', queueSkipAttachments: true },
    );
    expect(classifyStandaloneKind(node, [node])).toBe('user.taskNotification');
  });

  it('classifies a coordinator message to a subagent as its own kind', () => {
    const node = originUser(
      'coordinator',
      'The coordinator sent a message while you were working:\nTask 8 fix round 1',
      { isMeta: true, isSidechain: true, agentId: 'agent-a3830a6b9' },
    );
    expect(classifyStandaloneKind(node, [node])).toBe('user.coordinatorMessage');
  });

  it('leaves a human-origin record to the existing content rules', () => {
    const node = originUser('human', 'what happened with this message?');
    expect(classifyStandaloneKind(node, [node])).toBeNull();
  });

  it('leaves a record with no origin stamp alone', () => {
    expect(classifyStandaloneKind(userText('hello'), [])).toBeNull();
  });

  it('prefers the origin stamp over a content match in the same record', () => {
    const node = originUser('task-notification', '<command-name>/verify</command-name>');
    expect(classifyStandaloneKind(node, [node])).toBe('user.taskNotification');
  });

  it('ignores an unrecognised origin kind rather than inventing a kind for it', () => {
    const node = originUser('something-new', 'hello');
    expect(classifyStandaloneKind(node, [node])).toBeNull();
  });
});

describe('classifyStandaloneKind', () => {
  it('tags notification subtypes by notification_type', () => {
    expect(classifyStandaloneKind(notif('error'), [])).toBe('system.notification.error');
    expect(classifyStandaloneKind(notif('stop'), [])).toBe('system.notification.stop');
    expect(classifyStandaloneKind(notif('warn'), [])).toBe('system.notification.warn');
    expect(classifyStandaloneKind(notif('info'), [])).toBe('system.notification.info');
    expect(classifyStandaloneKind(notif('whatever'), [])).toBe('system.notification.info');
  });

  it("gives the CLI's live status frames (requesting / compacting) their own kind", () => {
    const status = { kind: 'system', subtype: 'status', sessionId: '', receivedAt: '', raw: { type: 'system', subtype: 'status', status: 'requesting' } } as unknown as JsonlNode;
    expect(classifyStandaloneKind(status, [])).toBe('system.status');
  });

  it('tags permission requests and summaries', () => {
    expect(classifyStandaloneKind(permReq('Bash'), [])).toBe('permission.request');
    expect(classifyStandaloneKind(summary(), [])).toBe('summary.compaction');
  });

  it('routes the live AskUserQuestion prompt to its own kind', () => {
    expect(classifyStandaloneKind(permReq('AskUserQuestion'), [])).toBe(
      'permission.askUserQuestion',
    );
  });

  describe('AskUserQuestion answered-pair elevation', () => {
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
      const tu = askUserQuestion('toolu_AUQ');
      expect(classifyStandaloneKind(tu, [tu])).toBeNull();
    });

    it('does NOT elevate when the assistant message has other renderable content alongside the tool_use', () => {
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
      expect(classifyStandaloneKind(sys('whatever'), [])).toBe('system.unknown');
    });

    // CLI 2.1.283 writes a local slash command's stdout as system/local_command,
    // not a user record.
    it('classifies system/local_command as its own kind', () => {
      expect(classifyStandaloneKind(sys('local_command'), [])).toBe('system.local_command');
    });

    // `/recap` lands as local_command too.
    it('classifies a /recap local_command as an away summary', () => {
      const recap = { kind: 'system', subtype: 'local_command', sessionId: '', receivedAt: '',
        raw: { type: 'system', subtype: 'local_command', content: '<local-command-stdout>We fixed it.</local-command-stdout>', commandRun: { command: 'recap', args: '' } } } as unknown as JsonlNode;
      const usage = { kind: 'system', subtype: 'local_command', sessionId: '', receivedAt: '',
        raw: { type: 'system', subtype: 'local_command', content: '<local-command-stdout>recap</local-command-stdout>', commandRun: { command: 'usage', args: '' } } } as unknown as JsonlNode;
      expect(classifyStandaloneKind(recap, [])).toBe('system.away_summary');
      expect(classifyStandaloneKind(usage, [])).toBe('system.local_command');
    });

    it('does not classify notification / known hook subtypes as unknown', () => {
      expect(classifyStandaloneKind(sys('hook_started'), [])).toBe('system.hook_started');
      expect(classifyStandaloneKind(sys('hook_response'), [])).toBe('system.hook_response');
      expect(classifyStandaloneKind(sys('hook_progress'), [])).toBe('system.hook_progress');
      expect(classifyStandaloneKind(sys('user_prompt_submit'), [])).toBe('system.userPromptSubmit');
    });

    it('classifies stop_hook_summary as its own kind, not the unknown catch-all', () => {
      expect(classifyStandaloneKind(sys('stop_hook_summary'), [])).toBe('system.stop_hook_summary');
    });

    it('classifies compact_boundary as its own kind, not the unknown catch-all', () => {
      expect(classifyStandaloneKind(sys('compact_boundary'), [])).toBe('system.compact_boundary');
    });

    it('gives the stream init and result envelopes registry kinds', () => {
      const init = { kind: 'cli-stream-init', raw: { type: 'system', subtype: 'init' }, sessionId: 's', receivedAt: '' } as JsonlNode;
      const result = { kind: 'cli-stream-result', raw: { type: 'result', subtype: 'success' }, sessionId: 's', receivedAt: '' } as JsonlNode;
      expect(classifyStandaloneKind(init, [])).toBe('system.init');
      expect(classifyStandaloneKind(result, [])).toBe('system.result');
    });

    it('classifies away_summary as its own separately-stylable kind', () => {
      expect(classifyStandaloneKind(sys('away_summary'), [])).toBe('system.away_summary');
    });

    it('classifies feedback_draft_queued as its own separately-stylable kind', () => {
      expect(classifyStandaloneKind(sys('feedback_draft_queued'), [])).toBe(
        'system.feedback_draft_queued',
      );
    });

    it('routes system.init to system.unknown (cli-stream-init intercepts init before this branch)', () => {
      expect(classifyStandaloneKind(sys('init'), [])).toBe('system.unknown');
    });
  });

  describe('system.thinking_tokens', () => {
    // system thinking_tokens is a running estimate, emitted roughly every ~50
    // thinking tokens.
    const sys = (extras: Record<string, unknown>): JsonlNode =>
      ({
        kind: 'system', subtype: 'thinking_tokens', sessionId: '', receivedAt: '',
        raw: { type: 'system', subtype: 'thinking_tokens', ...extras },
      }) as unknown as JsonlNode;

    it('classifies thinking_tokens as its own separately-stylable kind', () => {
      expect(
        classifyStandaloneKind(sys({ estimated_tokens: 800, estimated_tokens_delta: 50 }), []),
      ).toBe('system.thinking_tokens');
    });
  });

  describe('system.progress', () => {
    it('gives a top-level progress record its own stylable kind', () => {
      const node = {
        kind: 'progress', sessionId: '', receivedAt: null,
        raw: { type: 'progress', data: { type: 'bash_progress' } },
      } as unknown as JsonlNode;
      expect(classifyStandaloneKind(node, [])).toBe('system.progress');
    });
  });

  describe('system.rate_limit', () => {
    // rate_limit_event is a TOP-LEVEL `type` with no subtype; the overlay
    // `rate-limit` kind is skipped from the transcript.
    const rateLimitEvent = (extras: Record<string, unknown> = {}): JsonlNode =>
      ({
        kind: 'rate-limit-event', sessionId: '', receivedAt: '',
        raw: { type: 'rate_limit_event', ...extras },
      }) as unknown as JsonlNode;

    it('classifies rate_limit_event as its own separately-stylable kind', () => {
      expect(
        classifyStandaloneKind(
          rateLimitEvent({ rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } }),
          [],
        ),
      ).toBe('system.rate_limit');
    });

    it('classifies it the same way even with no rate_limit_info payload', () => {
      expect(classifyStandaloneKind(rateLimitEvent(), [])).toBe('system.rate_limit');
    });
  });

  describe('system.permission_denied', () => {
    // The CLI emits permission_denied when a tool call is auto-denied without a
    // prompt: classifier, dontAsk, headless auto-deny or a deny rule.
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
      // OmniFex's PermissionDenied hook emits its own system/permission_denied row,
      // with `reason` instead of `message`.
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

    const skillCompanion = (sourceToolUseID: string, text: string): JsonlNode =>
      ({
        kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '',
        raw: {
          type: 'user',
          isMeta: true,
          turnCompanion: true,
          sourceToolUseID,
          message: { role: 'user', content: [{ type: 'text', text }] },
        },
      }) as unknown as JsonlNode;

    it('classifies a companion of a Skill tool_use as user.skillInjection', () => {
      const tu = skillToolUse('tu_skill', 'merge-to-main');
      const tr = skillToolResult('tu_skill');
      const injected = skillCompanion('tu_skill', '# Merge to Main\n...');
      const msgs = [tu, tr, injected];
      expect(classifyStandaloneKind(injected, msgs)).toBe('user.skillInjection');
    });

    it('classifies the body of a re-invocation, not just the preamble', () => {
      // CLI 2.1.270 emits a "(Re-invocation of …)" record ahead of the body.
      const tu = skillToolUse('tu_skill', 'commit');
      const tr = skillToolResult('tu_skill');
      const preamble = skillCompanion('tu_skill', '(Re-invocation of /commit — …)');
      const body = skillCompanion('tu_skill', '# Commit\n\nUse this command when…');
      const msgs = [tu, tr, preamble, body];
      expect(classifyStandaloneKind(body, msgs)).toBe('user.skillInjection');
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

    it('leaves a prompt that quotes command tags as a prompt', () => {
      const quoted = userText('Look at this session.\n\n{"type":"system","content":"<local-command-stdout>You want every session</local-command-stdout>"}');
      expect(classifyStandaloneKind(quoted, [quoted])).toBeNull();
      const quotedCmd = userText('Why does this show twice? <command-name>/recap</command-name>');
      expect(classifyStandaloneKind(quotedCmd, [quotedCmd])).toBeNull();
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
    // The CLI delivers hook output as synthetic user-role messages.

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
      // The real shape: hook content in a <system-reminder>, then a plain "Stop hook
      // feedback: ..." body in the same text block.
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


describe('classifyStandaloneKind — bookkeeping kinds', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['permission-mode', { kind: 'permission-mode', raw: { type: 'permission-mode', permissionMode: 'acceptEdits' }, sessionId: 's' }],
    ['last-prompt', { kind: 'last-prompt', raw: { type: 'last-prompt', lastPrompt: 'hi', leafUuid: 'u' }, sessionId: 's' }],
    ['ai-title', { kind: 'ai-title', raw: { type: 'ai-title', aiTitle: 'T' }, sessionId: 's' }],
    ['custom-title', { kind: 'custom-title', raw: { type: 'custom-title', customTitle: 'T' }, sessionId: 's' }],
    ['queue-operation', { kind: 'queue-operation', raw: { type: 'queue-operation', operation: 'enqueue' }, sessionId: 's', receivedAt: 't' }],
    ['file-history-snapshot', { kind: 'file-history-snapshot', raw: { type: 'file-history-snapshot', snapshot: {} } }],
  ];
  it.each(cases)('returns %s for that node kind', (expected, node) => {
    expect(classifyStandaloneKind(node as unknown as JsonlNode, [])).toBe(expected);
  });
});

describe('classifyStandaloneKind — control-change', () => {
  it('returns control.<control> for a synthetic control-change node', () => {
    const e = { kind: 'control-change', control: 'effort', value: 'high', sessionId: 's', receivedAt: 't' };
    expect(classifyStandaloneKind(e as unknown as JsonlNode, [])).toBe('control.effort');
    const m = { kind: 'control-change', control: 'model', value: 'opus', sessionId: 's', receivedAt: 't' };
    expect(classifyStandaloneKind(m as unknown as JsonlNode, [])).toBe('control.model');
  });
});

describe('classifyStandaloneKind — CLI state records', () => {
  it('gives the CLI bookkeeping latches a kind of their own', () => {
    const node = { kind: 'unknown', sessionId: '', receivedAt: null, raw: { type: 'atis-latch', atis: '' } } as unknown as JsonlNode;
    expect(classifyStandaloneKind(node, [node])).toBe('cli-state');
  });

  it('leaves a type nothing knows unclassified', () => {
    const node = { kind: 'unknown', sessionId: '', receivedAt: null, raw: { type: 'brand-new' } } as unknown as JsonlNode;
    expect(classifyStandaloneKind(node, [node])).toBeNull();
  });
});

describe('classifyStandaloneKind — task lifecycle frames', () => {
  it('gives task_progress frames a kind of their own', () => {
    const node = { kind: 'unknown', sessionId: '', receivedAt: null, raw: { type: 'system', subtype: 'task_progress', task_id: 't1', description: 'x' } } as unknown as JsonlNode;
    expect(classifyStandaloneKind(node, [node])).toBe('task-lifecycle');
  });
});
