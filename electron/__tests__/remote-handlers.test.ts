import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRemoteHandlers, rpcErrorToProtocol, type RemoteHandlers } from '../remote/handlers';
import { createSessionLog, type SessionLog } from '../remote/session-log';
import { createSessionBridge, type SessionBridge } from '../remote/bridge';
import { createProjectRegistry, type ProjectRegistry } from '../remote/projects';
import type { SessionsService, SessionStartParams } from '../services/sessions/types';
import type { ClientContext } from '../../src/protocol/interfaces';
import type { ServerMessage, SessionScopedPush } from '../../src/protocol';
import { classifyJsonlLine } from '../../src/lib/jsonlClassifier';

/**
 * A sessions service double that records what it was asked and lets a test
 * drive `sendToRenderer` as the real service would.
 */
function fakeSessions(send: { current: (channel: string, ...args: unknown[]) => void }) {
  const active = new Set<string>();
  const calls = {
    start: [] as SessionStartParams[],
    send: [] as [string, string][],
    structured: [] as [string, unknown[]][],
    respond: [] as unknown[][],
    stop: [] as string[],
    interrupt: [] as string[],
  };
  let respondResult = true;
  const svc = {
    start: vi.fn(async (p: SessionStartParams) => {
      calls.start.push(p);
      active.add(p.tabId);
      send.current(`session-status:${p.tabId}`, { sessionStatus: 'started' });
      send.current(`session-init:${p.tabId}`, { sessionId: p.tabId, projectPath: p.projectPath });
    }),
    isActive: (id: string) => active.has(id),
    sendMessage: vi.fn((id: string, text: string) => { calls.send.push([id, text]); }),
    sendStructuredMessage: vi.fn((id: string, c: unknown[]) => { calls.structured.push([id, c]); }),
    respondPermission: vi.fn((...a: unknown[]) => { calls.respond.push(a); return respondResult; }),
    // Like the real service: stop() removes the handle and emits NOTHING —
    // runtime.ts suppresses the engine-exit status once the handle is gone.
    stop: vi.fn((id: string) => {
      calls.stop.push(id);
      active.delete(id);
    }),
    interrupt: vi.fn(async (id: string) => { calls.interrupt.push(id); }),
  } as unknown as SessionsService;
  return { svc, calls, active, setRespondResult: (v: boolean) => { respondResult = v; } };
}

function fakeCtx() {
  const sent: ServerMessage[] = [];
  const subs = new Set<string>();
  const ctx: ClientContext = {
    clientId: 'c1',
    clientKind: 'web',
    subscriptions: subs,
    subscribe: (id) => { subs.add(id); },
    unsubscribe: (id) => { subs.delete(id); },
    send: (m) => { sent.push(m); },
  };
  return { ctx, sent, subs };
}

describe('remote handlers', () => {
  let root: string;
  let repo: string;
  let log: SessionLog;
  let bridge: SessionBridge;
  let projects: ProjectRegistry;
  let published: SessionScopedPush[];
  let h: RemoteHandlers;
  let fake: ReturnType<typeof fakeSessions>;
  const sendRef = { current: (() => {}) as (channel: string, ...args: unknown[]) => void };
  let ids: string[];
  let resolveAccount: (p: string) => { accountId: number; configDir: string } | null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omnifex-handlers-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    published = [];
    ids = ['sid-1', 'sid-2', 'sid-3'];
    resolveAccount = () => ({ accountId: 1, configDir: '/cfg/personal' });
    log = createSessionLog({ root: join(root, 'sessions') });
    bridge = createSessionBridge({ log, classify: classifyJsonlLine, publish: (p) => { published.push(p); }, broadcast: () => {} });
    sendRef.current = bridge.sendToRenderer;
    projects = createProjectRegistry({ file: join(root, 'projects.json'), resolveAccount: (p) => resolveAccount(p) });
    fake = fakeSessions(sendRef);
    h = createRemoteHandlers({
      sessions: fake.svc,
      log,
      bridge,
      projects,
      rpc: {
        handlers: {
          list_accounts: async () => [{ id: 1 }],
          explode: async () => { throw new Error('[NO_ACCOUNT_FOR_PROJECT] nothing owns /x'); },
          plain_fail: async () => { throw new Error('disk full'); },
        },
        allow: new Set(['list_accounts', 'explode', 'plain_fail']),
      },
      daemonVersion: '0.0.0-test',
      newSessionId: () => ids.shift() ?? 'sid-overflow',
      now: () => '2026-09-10T03:00:00.000Z',
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const addProject = async () => h['project.add']({ path: repo }, fakeCtx().ctx);

  it('creates a session pinned to the id it minted, in the project\'s resolved account', async () => {
    const project = await addProject();
    const summary = await h['session.create']({ projectId: project.projectId, options: { model: 'claude-opus-5' } }, fakeCtx().ctx);

    expect(summary).toMatchObject({ sessionId: 'sid-1', projectId: project.projectId, sessionStatus: 'started', agent: 'claude', mode: 'rich' });
    expect(fake.calls.start[0]).toMatchObject({
      tabId: 'sid-1',
      resumeSessionId: 'sid-1',
      // Canonical: the registry realpaths (tmpdir is a symlink on macOS).
      projectPath: require('node:fs').realpathSync(repo),
      configDir: '/cfg/personal',
      model: 'claude-opus-5',
      permissionMode: 'default',
      agent: 'claude',
    });
    // The start pushes went through the bridge with a seq.
    expect(published.map((p) => [p.seq, p.type])).toEqual([[1, 'session.state'], [2, 'event']]);
    expect(log.meta('sid-1')).toMatchObject({ projectPath: require('node:fs').realpathSync(repo), configDir: '/cfg/personal' });
  });

  it('refuses to create a session for a project no account owns — no default account', async () => {
    resolveAccount = () => null;
    const project = await addProject();
    await expect(h['session.create']({ projectId: project.projectId }, fakeCtx().ctx)).rejects.toMatchObject({
      code: 'NO_ACCOUNT_FOR_PROJECT',
    });
    expect(fake.calls.start).toEqual([]);
  });

  it('honours an explicit account choice from the client', async () => {
    resolveAccount = () => null;
    const project = await addProject();
    await h['session.create']({ projectId: project.projectId, options: { configDir: '/cfg/work', manualAccountOverride: true } }, fakeCtx().ctx);
    expect(fake.calls.start[0]).toMatchObject({ configDir: '/cfg/work', manualAccountOverride: true });
  });

  it('rejects an unknown project', async () => {
    await expect(h['session.create']({ projectId: 'nope' }, fakeCtx().ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('sends text as a plain prompt and images as structured blocks', async () => {
    const project = await addProject();
    await h['session.create']({ projectId: project.projectId }, fakeCtx().ctx);
    h['turn.send']({ sessionId: 'sid-1', content: 'hi' }, fakeCtx().ctx);
    expect(fake.calls.send).toEqual([['sid-1', 'hi']]);

    h['turn.send']({ sessionId: 'sid-1', content: 'see', attachments: [{ name: 'a.png', mimeType: 'image/png', dataBase64: 'AAA=' }] }, fakeCtx().ctx);
    expect(fake.calls.structured[0][1]).toEqual([
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA=' } },
    ]);
  });

  it('kill announces the end of the session itself — stopped state and a complete event', async () => {
    const project = await addProject();
    await h['session.create']({ projectId: project.projectId }, fakeCtx().ctx);
    published.length = 0;
    h['session.kill']({ sessionId: 'sid-1' }, fakeCtx().ctx);
    expect(published.map((p) => (p.type === 'event' ? `event/${p.kind}` : `${p.type}/${(p as { sessionStatus: string }).sessionStatus}`))).toEqual([
      'session.state/stopped',
      'event/complete',
    ]);
    // Killing an already-dead session says nothing twice.
    published.length = 0;
    h['session.kill']({ sessionId: 'sid-1' }, fakeCtx().ctx);
    expect(published).toEqual([]);
  });

  it('refuses a turn on a session with no live process', async () => {
    const project = await addProject();
    await h['session.create']({ projectId: project.projectId }, fakeCtx().ctx);
    h['session.kill']({ sessionId: 'sid-1' }, fakeCtx().ctx);
    expect(() => h['turn.send']({ sessionId: 'sid-1', content: 'hi' }, fakeCtx().ctx)).toThrow(
      expect.objectContaining({ code: 'SESSION_NOT_RUNNING' }),
    );
    expect(h.summary('sid-1')).toMatchObject({ sessionStatus: 'stopped' });
  });

  it('resumes a persisted session by respawning with the same id and options, continuing the seq', async () => {
    const project = await addProject();
    await h['session.create']({ projectId: project.projectId, options: { model: 'claude-opus-5', permissionMode: 'acceptEdits' } }, fakeCtx().ctx);
    h['session.kill']({ sessionId: 'sid-1' }, fakeCtx().ctx);
    const seqBefore = log.lastSeq('sid-1');

    // A fresh handler set over the same state dir is what a daemon restart is.
    const log2 = createSessionLog({ root: join(root, 'sessions') });
    const published2: SessionScopedPush[] = [];
    const bridge2 = createSessionBridge({ log: log2, classify: classifyJsonlLine, publish: (p) => { published2.push(p); }, broadcast: () => {} });
    sendRef.current = bridge2.sendToRenderer;
    const fake2 = fakeSessions(sendRef);
    const h2 = createRemoteHandlers({ sessions: fake2.svc, log: log2, bridge: bridge2, projects, rpc: { handlers: {}, allow: new Set() }, daemonVersion: 't' });

    const summary = await h2['session.resume']({ sessionId: 'sid-1' }, fakeCtx().ctx);
    expect(fake2.calls.start[0]).toMatchObject({ tabId: 'sid-1', resumeSessionId: 'sid-1', model: 'claude-opus-5', permissionMode: 'acceptEdits', configDir: '/cfg/personal' });
    expect(summary.sessionStatus).toBe('started');
    expect(published2[0].seq).toBe(seqBefore + 1);
  });

  it('resume on a live session re-attaches without respawning', async () => {
    const project = await addProject();
    await h['session.create']({ projectId: project.projectId }, fakeCtx().ctx);
    await h['session.resume']({ sessionId: 'sid-1' }, fakeCtx().ctx);
    expect(fake.calls.start).toHaveLength(1);
  });

  it('resume of an unknown id is NOT_FOUND', async () => {
    await expect(h['session.resume']({ sessionId: 'ghost' }, fakeCtx().ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('subscribe replays after fromSeq into this client only, then reports the range', async () => {
    const project = await addProject();
    await h['session.create']({ projectId: project.projectId }, fakeCtx().ctx);
    bridge.sendToRenderer('agent-output:sid-1', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, receivedAt: '2026-09-10T03:00:01.000Z' });
    const { ctx, sent, subs } = fakeCtx();

    const res = h['session.subscribe']({ sessionId: 'sid-1', fromSeq: 1 }, ctx);
    expect(res).toEqual({ fromSeq: 1, lastSeq: 3 });
    expect(sent.map((m) => (m as { seq: number }).seq)).toEqual([2, 3]);
    expect([...subs]).toEqual(['sid-1']);

    const live = fakeCtx();
    expect(h['session.subscribe']({ sessionId: 'sid-1' }, live.ctx)).toEqual({ fromSeq: 3, lastSeq: 3 });
    expect(live.sent).toEqual([]);
  });

  it('reports a turn as in flight from send until the result row', async () => {
    const project = await addProject();
    await h['session.create']({ projectId: project.projectId }, fakeCtx().ctx);
    bridge.sendToRenderer('session-status:sid-1', { sessionStatus: 'started' });
    expect(h.summary('sid-1')).toMatchObject({ inFlight: false });

    h['turn.send']({ sessionId: 'sid-1', content: 'hello' }, fakeCtx().ctx);
    expect(h.summary('sid-1')).toMatchObject({ inFlight: true, pendingPermissions: 0 });

    bridge.sendToRenderer('agent-output:sid-1', { type: 'result', subtype: 'success', is_error: false, result: 'ok', receivedAt: '2026-09-10T03:00:02.000Z' });
    expect(h.summary('sid-1')).toMatchObject({ inFlight: false });
  });

  it('answers a permission by id and reports one that is not pending', async () => {
    const project = await addProject();
    await h['session.create']({ projectId: project.projectId }, fakeCtx().ctx);
    bridge.sendToRenderer('agent-output:sid-1', { type: 'permission_request', request_id: 'req-1', tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(h.summary('sid-1')).toMatchObject({ pendingPermissions: 1, inFlight: true });

    h['permission.respond']({ sessionId: 'sid-1', permissionId: 'req-1', decision: 'allow', updatedInput: { command: 'ls -la' } }, fakeCtx().ctx);
    expect(fake.calls.respond[0]).toEqual(['sid-1', 'allow', { command: 'ls -la' }, undefined, 'req-1']);
    expect(h.summary('sid-1')).toMatchObject({ pendingPermissions: 0, inFlight: false });

    fake.setRespondResult(false);
    expect(() => h['permission.respond']({ sessionId: 'sid-1', permissionId: 'stale', decision: 'deny' }, fakeCtx().ctx)).toThrow(
      expect.objectContaining({ code: 'PERMISSION_NOT_PENDING' }),
    );
  });

  it('lists sessions newest first, optionally per project', async () => {
    const project = await addProject();
    mkdirSync(join(root, 'other'), { recursive: true });
    const other = projects.add(join(root, 'other'));
    await h['session.create']({ projectId: project.projectId }, fakeCtx().ctx);
    await h['session.create']({ projectId: other.projectId }, fakeCtx().ctx);
    const all = await h['session.list']({}, fakeCtx().ctx);
    expect(all.map((s) => s.sessionId).sort()).toEqual(['sid-1', 'sid-2']);
    const mine = await h['session.list']({ projectId: other.projectId }, fakeCtx().ctx);
    expect(mine.map((s) => s.sessionId)).toEqual(['sid-2']);
  });

  it('pages history through the log', async () => {
    const project = await addProject();
    await h['session.create']({ projectId: project.projectId }, fakeCtx().ctx);
    const page = await h['history.get']({ sessionId: 'sid-1', limit: 1 }, fakeCtx().ctx);
    expect(page.events.map((e) => e.seq)).toEqual([2]);
    expect(page.hasMore).toBe(true);
  });

  describe('rpc.invoke', () => {
    it('dispatches an allowed channel', async () => {
      expect(await h['rpc.invoke']({ channel: 'list_accounts' }, fakeCtx().ctx)).toEqual([{ id: 1 }]);
    });

    it('refuses a channel outside the allowlist before looking it up', async () => {
      await expect(h['rpc.invoke']({ channel: 'session_start' }, fakeCtx().ctx)).rejects.toMatchObject({ code: 'CHANNEL_NOT_ALLOWED' });
    });

    it('lifts a [CODE]-prefixed IPC error to its protocol code and keeps other messages', async () => {
      await expect(h['rpc.invoke']({ channel: 'explode' }, fakeCtx().ctx)).rejects.toEqual({ code: 'NO_ACCOUNT_FOR_PROJECT', message: 'nothing owns /x' });
      await expect(h['rpc.invoke']({ channel: 'plain_fail' }, fakeCtx().ctx)).rejects.toEqual({ code: 'INTERNAL', message: 'disk full' });
    });

    it('does not invent a code it does not know', () => {
      expect(rpcErrorToProtocol(new Error('[WHATEVER] x'))).toEqual({ code: 'INTERNAL', message: '[WHATEVER] x' });
    });
  });

  it('project.add surfaces a bad path as MALFORMED_MESSAGE and project.remove an unknown id as NOT_FOUND', () => {
    expect(() => h['project.add']({ path: 'relative' }, fakeCtx().ctx)).toThrow(expect.objectContaining({ code: 'MALFORMED_MESSAGE' }));
    expect(() => h['project.remove']({ projectId: 'nope' }, fakeCtx().ctx)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});
