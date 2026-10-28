// @vitest-environment node
//
// AskUserQuestion's `unanswered` annotation (CLI 2.1.312,
// `ask_user_question_unanswered_v1`). A question the user closed, or talked
// past in chat, is answered with the text the model should read plus
// `annotations[question].unanswered`, so the transcript records how it ended
// instead of a bare "User denied permission". The capability gate is
// load-bearing: an older CLI on a strict host refuses the whole answer.
import { describe, it, expect, vi } from 'vitest';
import {
  respondPermission,
  answerPendingQuestionInChat,
  UNANSWERED_CAPABILITY,
} from '../services/sessions/permissions';
import type { SessionHandle, SendToRenderer } from '../services/sessions/types';

const QUESTIONS = [
  { question: 'Which DB?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
  { question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] },
];

type Queued = { requestId: string; toolInput?: Record<string, unknown>; payload?: Record<string, unknown> };

function askEntry(requestId = 'q1'): Queued {
  const toolInput = { questions: QUESTIONS };
  return { requestId, toolInput, payload: { type: 'permission_request', tool_name: 'AskUserQuestion', tool_input: toolInput } };
}

function bashEntry(requestId = 'b1'): Queued {
  const toolInput = { command: 'ls' };
  return { requestId, toolInput, payload: { type: 'permission_request', tool_name: 'Bash', tool_input: toolInput } };
}

function setup(queue: Queued[], capabilities: string[] | null = [UNANSWERED_CAPABILITY]) {
  const responses: { requestId: string; behavior: string; body?: any }[] = [];
  const engine = {
    respondPermission: vi.fn(async (requestId: string, behavior: string, body?: unknown) => {
      responses.push({ requestId, behavior, body });
    }),
    getInitData: () => (capabilities ? { capabilities } : {}),
  };
  const handle = {
    engine,
    permissionQueue: queue,
    configDir: '/cfg',
    projectPath: '/Users/greg/Repos/omnifex',
    permissionMode: 'default',
  } as unknown as SessionHandle;
  const sent: { channel: string; args: unknown[] }[] = [];
  const sendToRenderer: SendToRenderer = (channel, ...args) => { sent.push({ channel, args }); };
  return { handle, sendToRenderer, responses, sent };
}

describe('Cancel on an AskUserQuestion card', () => {
  it('answers every question as dismissed when the CLI advertises the capability', () => {
    const t = setup([askEntry()]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, 'deny');
    expect(t.responses).toHaveLength(1);
    const { behavior, body } = t.responses[0];
    expect(behavior).toBe('allow');
    expect(body.updatedInput.questions).toEqual(QUESTIONS);
    expect(Object.keys(body.updatedInput.answers)).toEqual(['Which DB?', 'Ship it?']);
    expect(body.updatedInput.answers['Which DB?']).toMatch(/dismissed/i);
    expect(body.updatedInput.annotations).toEqual({
      'Which DB?': { unanswered: 'dismissed' },
      'Ship it?': { unanswered: 'dismissed' },
    });
  });

  it('still denies on a CLI that does not advertise it', () => {
    const t = setup([askEntry()], null);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, 'deny');
    expect(t.responses[0].behavior).toBe('deny');
    expect(t.responses[0].body).toEqual({ behavior: 'deny', message: 'User denied permission' });
  });

  it('leaves a denied tool that is not AskUserQuestion a deny', () => {
    const t = setup([bashEntry()]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, 'deny');
    expect(t.responses[0].behavior).toBe('deny');
  });
});

describe('answerPendingQuestionInChat', () => {
  it('answers the question on screen as replied_in_chat and drops the card', () => {
    const t = setup([askEntry()]);
    expect(answerPendingQuestionInChat(t.handle, 'tab1', t.sendToRenderer)).toBe(true);
    const { behavior, body } = t.responses[0];
    expect(behavior).toBe('allow');
    expect(body.updatedInput.annotations['Ship it?']).toEqual({ unanswered: 'replied_in_chat' });
    expect(body.updatedInput.answers['Ship it?']).toMatch(/chat/i);
    expect(t.handle.permissionQueue).toHaveLength(0);
    expect(t.sent).toContainEqual({
      channel: 'agent-output:tab1',
      args: [{ type: 'permission_withdrawn', request_id: 'q1' }],
    });
  });

  it('shows the next queued request instead of withdrawing when one is waiting', () => {
    const next = bashEntry();
    const t = setup([askEntry(), next]);
    answerPendingQuestionInChat(t.handle, 'tab1', t.sendToRenderer);
    expect(t.handle.permissionQueue).toEqual([next]);
    expect(t.sent.some((s) => (s.args[0] as any)?.type === 'permission_withdrawn')).toBe(false);
    expect(t.sent).toContainEqual({ channel: 'agent-output:tab1', args: [next.payload] });
  });

  it('does nothing when the head is not a question', () => {
    const t = setup([bashEntry()]);
    expect(answerPendingQuestionInChat(t.handle, 'tab1', t.sendToRenderer)).toBe(false);
    expect(t.responses).toEqual([]);
  });

  it('does nothing on a CLI without the capability — the message queues as before', () => {
    const t = setup([askEntry()], null);
    expect(answerPendingQuestionInChat(t.handle, 'tab1', t.sendToRenderer)).toBe(false);
    expect(t.responses).toEqual([]);
    expect(t.handle.permissionQueue).toHaveLength(1);
  });
});
