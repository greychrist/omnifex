// @vitest-environment node
//
// `respondPermission` — what runs when the user clicks Allow or Deny.
//
// It was the largest untested block in sessions/permissions.ts, and it owns
// three things that have each been a bug before:
//
//   1. The session-destination twin. A persistent rule that isn't mirrored to
//      `session` lands on disk but never enters the running CLI's rule cache,
//      so the very next matching tool_use re-prompts — the "permissions never
//      really stick" symptom.
//   2. Codex vs Claude response shapes. A Codex approval takes a bare
//      decision; sending the Claude-shaped body spreads garbage into Codex's
//      JSON-RPC result envelope.
//   3. Draining the queue. The next queued request has to be pushed to the
//      renderer AND re-notified, or a stacked prompt goes invisible.
import { describe, it, expect, vi } from 'vitest';
import {
  respondPermission,
  permissionNotificationContent,
  createPermissionRequestHandler,
} from '../services/sessions/permissions';
import type {
  SessionHandle,
  SendToRenderer,
  NotificationHooks,
} from '../services/sessions/types';
import type { LoggingService } from '../services/logging';

type Queued = {
  requestId: string;
  toolInput?: Record<string, unknown>;
  payload?: Record<string, unknown>;
};

function setup(queue: Queued[], opts: { engine?: boolean } = {}) {
  const responses: { requestId: string; behavior: string; body?: unknown }[] = [];
  const engine = {
    respondPermission: vi.fn(async (requestId: string, behavior: string, body?: unknown) => {
      responses.push({ requestId, behavior, body });
    }),
  };
  const handle = {
    engine: opts.engine === false ? null : engine,
    permissionQueue: queue,
    configDir: '/cfg',
    projectPath: '/Users/greg/Repos/omnifex',
    permissionMode: 'default',
  } as unknown as SessionHandle;

  const sent: { channel: string; args: unknown[] }[] = [];
  const sendToRenderer: SendToRenderer = (channel, ...args) => {
    sent.push({ channel, args });
  };
  const notifications: unknown[][] = [];
  const hooks = {
    showNotification: vi.fn((...a: unknown[]) => {
      notifications.push(a);
    }),
    incrementUnread: vi.fn(),
  } as unknown as NotificationHooks;

  const persisted: Record<string, unknown>[] = [];
  const persist = vi.fn((r: Record<string, unknown>) => {
    persisted.push(r);
  });

  return { handle, sendToRenderer, hooks, persist, responses, sent, notifications, persisted };
}

const allowRule = (destination: string, toolName = 'Edit', ruleContent?: string) => ({
  type: 'addRules',
  behavior: 'allow',
  destination,
  rules: [{ toolName, ...(ruleContent ? { ruleContent } : {}) }],
});

describe('respondPermission — engine response body', () => {
  it('sends behavior and updatedInput on allow', () => {
    const t = setup([{ requestId: 'req1', toolInput: { file_path: '/a.ts' } }]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow');
    expect(t.responses).toEqual([
      { requestId: 'req1', behavior: 'allow', body: { behavior: 'allow', updatedInput: { file_path: '/a.ts' } } },
    ]);
  });

  // The CLI rejects an allow with no updatedInput, so the captured original
  // is the fallback — never `{}` when we have the real input.
  it('prefers caller-supplied updatedInput over the captured original', () => {
    const t = setup([{ requestId: 'req1', toolInput: { file_path: '/a.ts' } }]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow', { file_path: '/b.ts' });
    expect((t.responses[0].body as { updatedInput: unknown }).updatedInput).toEqual({ file_path: '/b.ts' });
  });

  it('falls back to an empty object when nothing captured the input', () => {
    const t = setup([{ requestId: 'req1' }]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow');
    expect((t.responses[0].body as { updatedInput: unknown }).updatedInput).toEqual({});
  });

  it('sends a denial message rather than updatedInput on deny', () => {
    const t = setup([{ requestId: 'req1', toolInput: { file_path: '/a.ts' } }]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'deny');
    expect(t.responses[0].body).toEqual({ behavior: 'deny', message: 'User denied permission' });
  });

  it('is a no-op on an empty queue', () => {
    const t = setup([]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow');
    expect(t.responses).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it('still drains the queue when no engine is attached', () => {
    const t = setup([{ requestId: 'req1' }], { engine: false });
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow');
    expect(t.handle.permissionQueue).toHaveLength(0);
  });

  // A rejected respondPermission is logged, not thrown: this runs off an IPC
  // click handler with nowhere to propagate to.
  it('swallows an engine rejection', () => {
    const t = setup([{ requestId: 'req1' }]);
    (t.handle.engine as unknown as { respondPermission: ReturnType<typeof vi.fn> })
      .respondPermission.mockRejectedValueOnce(new Error('closed'));
    expect(() =>
      respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow'),
    ).not.toThrow();
  });
});

describe('respondPermission — the session-destination twin', () => {
  // Without the twin the rule is on disk but invisible to the running query.
  it('mirrors a persistent allow rule to the session destination', () => {
    const t = setup([{ requestId: 'req1' }]);
    respondPermission(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow', undefined,
      [allowRule('localSettings')] as never,
    );
    const body = t.responses[0].body as { updatedPermissions: { destination: string }[] };
    expect(body.updatedPermissions.map((u) => u.destination)).toEqual(['localSettings', 'session']);
  });

  // Deny is deliberately NOT augmented — a denial applies to this request,
  // and folding it into the live rule cache would silently ban the tool.
  it('does not augment on deny', () => {
    const t = setup([{ requestId: 'req1' }]);
    respondPermission(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, 'deny', undefined,
      [allowRule('localSettings')] as never,
    );
    expect(t.responses[0].body).toEqual({ behavior: 'deny', message: 'User denied permission' });
  });

  it('omits updatedPermissions entirely when there are none', () => {
    const t = setup([{ requestId: 'req1' }]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow', undefined, [] as never);
    expect('updatedPermissions' in (t.responses[0].body as object)).toBe(false);
  });
});

describe('respondPermission — persisting rules to disk', () => {
  it('writes a rule for each settings-file destination', () => {
    const t = setup([{ requestId: 'req1' }]);
    respondPermission(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow', undefined,
      [allowRule('userSettings', 'Bash', 'ls:*')] as never,
      t.persist,
    );
    expect(t.persisted).toEqual([
      {
        scope: 'user',
        behavior: 'allow',
        rule: 'Bash(ls:*)',
        configDir: '/cfg',
        projectPath: '/Users/greg/Repos/omnifex',
      },
    ]);
  });

  it('maps every destination to its settings scope', () => {
    const t = setup([{ requestId: 'req1' }]);
    respondPermission(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow', undefined,
      [
        allowRule('userSettings', 'A'),
        allowRule('projectSettings', 'B'),
        allowRule('localSettings', 'C'),
      ] as never,
      t.persist,
    );
    expect(t.persisted.map((p) => p.scope)).toEqual(['user', 'project', 'local']);
  });

  // The session twin is an apply-now instruction, not a persistence target.
  // Iterating the augmented array here would double-write every rule.
  it('never writes the session twin to disk', () => {
    const t = setup([{ requestId: 'req1' }]);
    respondPermission(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow', undefined,
      [allowRule('localSettings'), allowRule('session')] as never,
      t.persist,
    );
    expect(t.persisted).toHaveLength(1);
    expect(t.persisted[0].scope).toBe('local');
  });

  it('renders a rule with no content as a bare tool name', () => {
    const t = setup([{ requestId: 'req1' }]);
    respondPermission(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow', undefined,
      [allowRule('localSettings', 'Read')] as never,
      t.persist,
    );
    expect(t.persisted[0].rule).toBe('Read');
  });

  it('carries a deny suggestion through as a deny rule', () => {
    const t = setup([{ requestId: 'req1' }]);
    respondPermission(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow', undefined,
      [{ ...allowRule('localSettings', 'Bash', 'rm:*'), behavior: 'deny' }] as never,
      t.persist,
    );
    expect(t.persisted[0].behavior).toBe('deny');
  });

  it('skips malformed rule entries rather than writing junk', () => {
    const t = setup([{ requestId: 'req1' }]);
    respondPermission(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow', undefined,
      [{
        type: 'addRules', behavior: 'allow', destination: 'localSettings',
        rules: [null, { toolName: '' }, { toolName: '   ' }, { toolName: 42 }, { toolName: 'Edit' }],
      }] as never,
      t.persist,
    );
    expect(t.persisted.map((p) => p.rule)).toEqual(['Edit']);
  });

  it('tolerates a suggestion carrying no rules array', () => {
    const t = setup([{ requestId: 'req1' }]);
    respondPermission(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow', undefined,
      [{ type: 'addRules', behavior: 'allow', destination: 'localSettings' }] as never,
      t.persist,
    );
    expect(t.persisted).toEqual([]);
  });

  // A failed disk write must not abandon the rest of the batch, and must not
  // take down the click handler.
  it('keeps persisting after one write throws', () => {
    const t = setup([{ requestId: 'req1' }]);
    const persist = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('EACCES');
      })
      .mockImplementation(() => {});
    respondPermission(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow', undefined,
      [allowRule('userSettings', 'A'), allowRule('localSettings', 'B')] as never,
      persist,
    );
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('persists nothing on deny', () => {
    const t = setup([{ requestId: 'req1' }]);
    respondPermission(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, 'deny', undefined,
      [allowRule('localSettings')] as never,
      t.persist,
    );
    expect(t.persisted).toEqual([]);
  });

  // 'session' and an absent destination both mean "don't write me".
  it('persists nothing for session-only or destination-less suggestions', () => {
    const t = setup([{ requestId: 'req1' }]);
    respondPermission(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow', undefined,
      [allowRule('session'), { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'X' }] },
       allowRule('somethingNew')] as never,
      t.persist,
    );
    expect(t.persisted).toEqual([]);
  });
});

describe('respondPermission — draining a stacked queue', () => {
  const nextTool = {
    kind: 'tool',
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
  };

  it('pushes the next queued request to the renderer and re-notifies', () => {
    const t = setup([{ requestId: 'req1' }, { requestId: 'req2', payload: nextTool }]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow');

    expect(t.sent[0]).toEqual({ channel: 'agent-output:tab1', args: [nextTool] });
    const notif = t.sent[1];
    expect(notif.channel).toBe('claude-notification');
    // Title carries the project basename so a stacked prompt says which repo.
    expect((notif.args[0] as { title: string }).title).toBe('OmniFex — omnifex');
    expect(t.notifications).toHaveLength(1);
    expect((t.hooks as unknown as { incrementUnread: ReturnType<typeof vi.fn> }).incrementUnread)
      .toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the queue is drained', () => {
    const t = setup([{ requestId: 'req1' }]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow');
    expect(t.sent).toEqual([]);
  });

  // Codex approvals carry the engine's own summary rather than a tool name.
  it('uses the engine summary for a queued Codex patch', () => {
    const t = setup([
      { requestId: 'req1' },
      { requestId: 'req2', payload: { kind: 'patch', summary: 'Apply 3 edits to api.ts' } },
    ]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow');
    expect((t.sent[1].args[0] as { body: string }).body).toBe('Apply 3 edits to api.ts');
  });

  it('falls back to a generic label for a summary-less Codex patch', () => {
    const t = setup([{ requestId: 'req1' }, { requestId: 'req2', payload: { kind: 'patch' } }]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow');
    expect((t.sent[1].args[0] as { body: string }).body).toBe('Apply patch');
  });

  it('falls back to a generic label for a summary-less Codex exec', () => {
    const t = setup([{ requestId: 'req1' }, { requestId: 'req2', payload: { kind: 'exec' } }]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow');
    expect((t.sent[1].args[0] as { body: string }).body).toBe('Run command');
  });

  // Diagnostics must not take down the click handler mid-drain.
  it('survives a throwing notification hook', () => {
    const t = setup([{ requestId: 'req1' }, { requestId: 'req2', payload: nextTool }]);
    (t.hooks as unknown as { showNotification: ReturnType<typeof vi.fn> })
      .showNotification.mockImplementation(() => {
        throw new Error('no display');
      });
    expect(() =>
      respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow'),
    ).not.toThrow();
  });

  it('names the app when the project path has no basename', () => {
    const t = setup([{ requestId: 'req1' }, { requestId: 'req2', payload: nextTool }]);
    (t.handle as unknown as { projectPath: string }).projectPath = '/';
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow');
    expect((t.sent[1].args[0] as { title: string }).title).toBe('OmniFex — OmniFex');
  });
});

describe('respondPermission — Codex approvals', () => {
  // Codex's engine maps the bare decision onto its own JSON-RPC envelope.
  // A Claude-shaped body would spread garbage into that result.
  it('sends a bare decision for a patch approval', () => {
    const t = setup([{ requestId: 'req1', payload: { kind: 'patch' } }]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow');
    expect(t.responses).toEqual([{ requestId: 'req1', behavior: 'allow', body: undefined }]);
  });

  it('sends a bare decision for an exec approval', () => {
    const t = setup([{ requestId: 'req1', payload: { kind: 'exec' } }]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'deny');
    expect(t.responses).toEqual([{ requestId: 'req1', behavior: 'deny', body: undefined }]);
  });

  it('sends the Claude body for a tool-kind payload', () => {
    const t = setup([{ requestId: 'req1', payload: { kind: 'tool' }, toolInput: { a: 1 } }]);
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow');
    expect(t.responses[0].body).toEqual({ behavior: 'allow', updatedInput: { a: 1 } });
  });
});

describe('permissionNotificationContent', () => {
  // AskUserQuestion rides the permission channel but the agent is ASKING,
  // not requesting a tool — the subtitle is the only thing distinguishing them.
  it('labels AskUserQuestion as an answer request and quotes the question', () => {
    expect(
      permissionNotificationContent('AskUserQuestion', {
        questions: [{ question: '  Which database?  ' }],
      }),
    ).toEqual({ subtitle: 'Answer Needed:', body: 'Which database?' });
  });

  it('falls back when the question text is missing or malformed', () => {
    for (const input of [
      { questions: [] },
      { questions: [{ question: 42 }] },
      { questions: 'nope' },
      {},
      undefined,
    ]) {
      expect(permissionNotificationContent('AskUserQuestion', input as never)).toEqual({
        subtitle: 'Answer Needed:',
        body: 'Awaiting your response',
      });
    }
  });

  it('labels every other tool as a permission request', () => {
    const out = permissionNotificationContent('Bash', { command: 'ls -la' });
    expect(out.subtitle).toBe('Permission Request:');
    expect(out.body.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The Codex approval branch of createPermissionRequestHandler
// ---------------------------------------------------------------------------

describe('createPermissionRequestHandler — Codex approvals', () => {
  function codexSetup(permissionMode = 'default') {
    const t = setup([]);
    (t.handle as unknown as { permissionMode: string }).permissionMode = permissionMode;
    const rows: Record<string, unknown>[] = [];
    const logging = {
      writeBatch: vi.fn((b: Record<string, unknown>[]) => {
        rows.push(...b);
      }),
    } as unknown as LoggingService;
    const onRequest = createPermissionRequestHandler(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, logging,
    );
    const meta = (n = 0) => JSON.parse(rows[n].metadata as string) as Record<string, unknown>;
    return { ...t, onRequest, rows, meta, logging };
  }

  const patchReq = (over: Record<string, unknown> = {}) =>
    ({ requestId: 'req1', kind: 'patch', summary: 'Apply 2 edits', payload: { files: ['a.ts'] }, ...over }) as never;

  it('queues a patch approval and pushes it to the renderer', () => {
    const t = codexSetup();
    t.onRequest(patchReq());
    expect(t.handle.permissionQueue).toHaveLength(1);
    const payload = t.sent[0].args[0] as Record<string, unknown>;
    expect(t.sent[0].channel).toBe('agent-output:tab1');
    expect(payload).toMatchObject({
      type: 'permission_request',
      request_id: 'req1',
      kind: 'patch',
      agent: 'codex',
      summary: 'Apply 2 edits',
      codex_payload: { files: ['a.ts'] },
      // Claude fields are stubbed so the renderer's normalizer can't crash.
      tool_name: 'apply_patch',
      tool_input: {},
      permission_suggestions: [],
    });
  });

  it('stubs the Claude tool name as exec_command for an exec approval', () => {
    const t = codexSetup();
    t.onRequest(patchReq({ kind: 'exec', summary: 'Run ls' }));
    expect((t.sent[0].args[0] as { tool_name: string }).tool_name).toBe('exec_command');
  });

  it('falls back to a generic summary when the engine sent none', () => {
    const t = codexSetup();
    t.onRequest(patchReq({ summary: undefined }));
    expect((t.sent[0].args[0] as { summary: string }).summary).toBe('Apply patch');
    const t2 = codexSetup();
    t2.onRequest(patchReq({ kind: 'exec', summary: undefined }));
    expect((t2.sent[0].args[0] as { summary: string }).summary).toBe('Run command');
  });

  it('notifies only for the head of the queue', () => {
    const t = codexSetup();
    t.onRequest(patchReq());
    t.onRequest(patchReq({ requestId: 'req2' }));
    expect(t.handle.permissionQueue).toHaveLength(2);
    // One agent-output + one claude-notification for the first request only.
    expect(t.sent.filter((s) => s.channel === 'claude-notification')).toHaveLength(1);
  });

  // bypassPermissions and dontAsk are tool-name-agnostic, so they can decide
  // a Codex approval without a prompt.
  it('auto-allows under bypassPermissions without queuing', () => {
    const t = codexSetup('bypassPermissions');
    t.onRequest(patchReq());
    expect(t.responses).toEqual([{ requestId: 'req1', behavior: 'allow', body: undefined }]);
    expect(t.handle.permissionQueue).toHaveLength(0);
    expect(t.sent).toEqual([]);
    expect(t.meta()).toMatchObject({ event: 'permission.decision', agent: 'codex', behavior: 'allow' });
  });

  it('auto-denies under dontAsk without queuing', () => {
    const t = codexSetup('dontAsk');
    t.onRequest(patchReq());
    expect(t.responses).toEqual([{ requestId: 'req1', behavior: 'deny', body: undefined }]);
    expect(t.handle.permissionQueue).toHaveLength(0);
  });

  // acceptEdits keys off Claude file-edit tool names, so it cannot match a
  // `codex.patch` pseudo-tool and must fall through to the prompt.
  it('still prompts under acceptEdits, which cannot match a Codex kind', () => {
    const t = codexSetup('acceptEdits');
    t.onRequest(patchReq());
    expect(t.responses).toEqual([]);
    expect(t.handle.permissionQueue).toHaveLength(1);
  });

  it('logs the request that reached the prompt', () => {
    const t = codexSetup();
    t.onRequest(patchReq());
    expect(t.meta()).toMatchObject({
      event: 'permission.request',
      agent: 'codex',
      kind: 'patch',
      request_id: 'req1',
    });
  });

  it('works with no logging wired', () => {
    const t = setup([]);
    const onRequest = createPermissionRequestHandler(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, null,
    );
    expect(() => onRequest(patchReq())).not.toThrow();
    expect(t.handle.permissionQueue).toHaveLength(1);
  });

  it('survives a throwing logger', () => {
    const t = setup([]);
    const logging = {
      writeBatch: vi.fn(() => {
        throw new Error('db locked');
      }),
    } as unknown as LoggingService;
    const onRequest = createPermissionRequestHandler(
      t.handle, 'tab1', t.sendToRenderer, t.hooks, logging,
    );
    expect(() => onRequest(patchReq())).not.toThrow();
    expect(t.handle.permissionQueue).toHaveLength(1);
  });

  it('survives a throwing notification hook', () => {
    const t = codexSetup();
    (t.hooks as unknown as { showNotification: ReturnType<typeof vi.fn> })
      .showNotification.mockImplementation(() => {
        throw new Error('no display');
      });
    expect(() => t.onRequest(patchReq())).not.toThrow();
  });
});

// The Remote daemon answers a permission by id, not by queue position: with two
// clients subscribed to one session, an unaddressed Allow would resolve
// whichever request happened to be at the head — possibly one the clicking
// user never saw. The desktop path (no requestId) must keep its head-of-queue
// behaviour exactly.
describe('respondPermission — addressed by requestId', () => {
  const byId = (t: ReturnType<typeof setup>, requestId?: string) =>
    respondPermission(t.handle, 'tab1', t.sendToRenderer, t.hooks, 'allow', undefined, undefined, undefined, requestId);

  it('answers the head and reports success when no requestId is given', () => {
    const t = setup([
      { requestId: 'req1' },
      { requestId: 'req2', payload: { type: 'permission_request', request_id: 'req2', tool_name: 'Read', tool_input: {} } },
    ]);
    expect(byId(t)).toBe(true);
    expect(t.responses.map((r) => r.requestId)).toEqual(['req1']);
  });

  it('answers the named request even when it is not at the head, without re-showing the head', () => {
    const t = setup([{ requestId: 'req1', payload: { type: 'permission_request', request_id: 'req1' } }, { requestId: 'req2' }]);
    expect(byId(t, 'req2')).toBe(true);
    expect(t.responses.map((r) => r.requestId)).toEqual(['req2']);
    expect(t.handle.permissionQueue.map((q) => q.requestId)).toEqual(['req1']);
    // The head is still the head; the renderer is already showing it.
    expect(t.sent).toEqual([]);
  });

  it('shows the next request when the head is answered by id', () => {
    const t = setup([
      { requestId: 'req1' },
      { requestId: 'req2', payload: { type: 'permission_request', request_id: 'req2', tool_name: 'Bash', tool_input: {} } },
    ]);
    expect(byId(t, 'req1')).toBe(true);
    expect(t.sent.some((s) => s.channel === 'agent-output:tab1')).toBe(true);
  });

  it('returns false and touches nothing for an unknown requestId', () => {
    const t = setup([{ requestId: 'req1' }]);
    expect(byId(t, 'nope')).toBe(false);
    expect(t.responses).toEqual([]);
    expect(t.handle.permissionQueue).toHaveLength(1);
  });

  it('returns false on an empty queue', () => {
    expect(byId(setup([]), 'req1')).toBe(false);
  });
});

