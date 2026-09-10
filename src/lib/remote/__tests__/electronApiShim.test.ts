import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createElectronApiShim, TAB_MAP_STORAGE_KEY } from '@/lib/remote/electronApiShim';
import type { ProtocolClient, ConnectionState } from '@/protocol/interfaces';
import type { ServerMessage, SessionSummary } from '@/protocol';
import type { NativeBridge } from '@/lib/platform';

/** A protocol client double: records requests, lets the test push. */
function fakeClient() {
  const requests: Array<{ method: string; params: unknown }> = [];
  const pushListeners = new Set<(m: ServerMessage) => void>();
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const responders: Record<string, (params: any) => unknown> = {};
  const client: ProtocolClient = {
    state: 'connected',
    connect: async () => ({ protocolVersion: 1, daemonVersion: 't' }),
    disconnect: () => {},
    request: (async (method: string, params: unknown) => {
      requests.push({ method, params });
      const r = responders[method];
      if (!r) throw new Error(`no responder for ${method}`);
      return r(params);
    }) as ProtocolClient['request'],
    onPush: (l) => { pushListeners.add(l); return () => pushListeners.delete(l); },
    onStateChange: (l) => { stateListeners.add(l); return () => stateListeners.delete(l); },
  };
  return {
    client,
    requests,
    responders,
    push: (m: ServerMessage) => { for (const l of pushListeners) l(m); },
    setState: (s: ConnectionState) => { for (const l of stateListeners) l(s); },
  };
}

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, dump: () => Object.fromEntries(m) };
}

const summary = (sessionId: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId,
  projectId: 'p1',
  agent: 'claude',
  mode: 'rich',
  sessionStatus: 'started',
  lastSeq: 2,
  pendingPermissions: 0,
  inFlight: false,
  ...over,
});

describe('electronAPI shim', () => {
  let f: ReturnType<typeof fakeClient>;
  let native: { invoke: ReturnType<typeof vi.fn>; onEvent: ReturnType<typeof vi.fn> };
  let storage: ReturnType<typeof memStorage>;

  beforeEach(() => {
    f = fakeClient();
    native = { invoke: vi.fn(async () => 'native-result'), onEvent: vi.fn(() => () => {}) };
    storage = memStorage();
    f.responders['project.add'] = (p) => ({ projectId: 'p1', path: p.path, configDir: '/cfg' });
    f.responders['session.create'] = () => summary('sid-1');
    f.responders['session.subscribe'] = (p) => ({ fromSeq: p.fromSeq ?? 2, lastSeq: 2 });
    f.responders['turn.send'] = () => undefined;
    f.responders['turn.interrupt'] = () => undefined;
    f.responders['permission.respond'] = () => undefined;
    f.responders['session.kill'] = () => undefined;
    f.responders['rpc.invoke'] = (p) => ({ rpc: p.channel, params: p.params });
  });

  const shim = () => createElectronApiShim({ client: f.client, native: native as unknown as NativeBridge, storage });

  describe('session_start', () => {
    it('adds the project, creates the session, subscribes live, maps the tab, and announces init + status', async () => {
      const api = shim();
      const status: unknown[] = [];
      const init: unknown[] = [];
      api.onEvent('session-status:tab-A', (p) => status.push(p));
      api.onEvent('session-init:tab-A', (p) => init.push(p));

      await api.invoke('session_start', {
        tabId: 'tab-A', projectPath: '/Users/greg/Repos/x', model: 'claude-opus-5', permissionMode: 'default',
        resumeSessionId: undefined, configDir: '/cfg', effort: 'high', thinking: { type: 'adaptive' }, mode: 'rich', manualAccountOverride: false, agent: 'claude',
      });

      expect(f.requests.map((r) => r.method)).toEqual(['project.add', 'session.create', 'session.subscribe']);
      expect(f.requests[1].params).toEqual({
        projectId: 'p1',
        options: { model: 'claude-opus-5', permissionMode: 'default', effort: 'high', thinking: { type: 'adaptive' }, mode: 'rich', agent: 'claude', configDir: '/cfg', manualAccountOverride: false },
      });
      // Live-only: no fromSeq.
      expect(f.requests[2].params).toEqual({ sessionId: 'sid-1' });
      expect(status).toEqual([{ sessionStatus: 'started' }]);
      expect(init).toEqual([{ sessionId: 'sid-1', projectPath: '/Users/greg/Repos/x' }]);
      expect(JSON.parse(storage.getItem(TAB_MAP_STORAGE_KEY)!)).toEqual({ 'tab-A': 'sid-1' });
    });

    it('resumes when given a resumeSessionId, and adopts an unknown transcript via create', async () => {
      const api = shim();
      f.responders['session.resume'] = () => summary('sid-old');
      await api.invoke('session_start', { tabId: 't1', projectPath: '/p', resumeSessionId: 'sid-old', model: 'default', permissionMode: 'default' });
      expect(f.requests.map((r) => r.method)).toEqual(['project.add', 'session.resume', 'session.subscribe']);

      f.requests.length = 0;
      f.responders['session.resume'] = () => { throw Object.assign(new Error('nope'), { code: 'NOT_FOUND' }); };
      f.responders['session.create'] = (p) => summary(p.options.resumeSessionId);
      await api.invoke('session_start', { tabId: 't2', projectPath: '/p', resumeSessionId: 'sid-foreign', model: 'default', permissionMode: 'default' });
      expect(f.requests.map((r) => r.method)).toEqual(['project.add', 'session.resume', 'session.create', 'session.subscribe']);
      expect((f.requests[2].params as { options: { resumeSessionId: string } }).options.resumeSessionId).toBe('sid-foreign');
    });

    it('surfaces a daemon error in the [CODE] form the renderer already decodes', async () => {
      const api = shim();
      f.responders['session.create'] = () => { throw Object.assign(new Error('no account resolves /p'), { code: 'NO_ACCOUNT_FOR_PROJECT' }); };
      await expect(api.invoke('session_start', { tabId: 't', projectPath: '/p', model: 'default', permissionMode: 'default' })).rejects.toThrow(
        '[NO_ACCOUNT_FOR_PROJECT] no account resolves /p',
      );
    });
  });

  describe('pushes → legacy channels', () => {
    async function started() {
      const api = shim();
      await api.invoke('session_start', { tabId: 'tab-A', projectPath: '/p', model: 'default', permissionMode: 'default' });
      return api;
    }

    it('re-emits transcript events as the raw CLI object on agent-output / claude-output-extra', async () => {
      const api = await started();
      const out: unknown[] = [];
      const extra: unknown[] = [];
      api.onEvent('agent-output:tab-A', (p) => out.push(p));
      api.onEvent('claude-output-extra:tab-A', (p) => extra.push(p));
      f.push({ type: 'event', sessionId: 'sid-1', seq: 3, kind: 'transcript', origin: 'engine', channel: 'agent-output', payload: { kind: 'assistant', raw: { type: 'assistant', x: 1 } } });
      f.push({ type: 'event', sessionId: 'sid-1', seq: 4, kind: 'transcript', origin: 'tail', channel: 'claude-output-extra', payload: { kind: 'queue-operation', raw: { type: 'queue-operation' } } });
      f.push({ type: 'event', sessionId: 'sid-other', seq: 1, kind: 'transcript', channel: 'agent-output', payload: { raw: { type: 'assistant' } } });
      expect(out).toEqual([{ type: 'assistant', x: 1 }]);
      expect(extra).toEqual([{ type: 'queue-operation' }]);
    });

    it('re-emits status only on change, mode only on change, complete with no args, and stderr as a string', async () => {
      const api = await started();
      const status: unknown[] = [];
      const mode: unknown[] = [];
      const complete = vi.fn();
      const stderr: unknown[] = [];
      api.onEvent('session-status:tab-A', (p) => status.push(p));
      api.onEvent('session-mode:tab-A', (p) => mode.push(p));
      api.onEvent('agent-complete:tab-A', complete);
      api.onEvent('agent-error:tab-A', (p) => stderr.push(p));

      f.push({ type: 'session.state', sessionId: 'sid-1', seq: 3, sessionStatus: 'started', mode: 'rich', agent: 'claude' });
      f.push({ type: 'session.state', sessionId: 'sid-1', seq: 4, sessionStatus: 'started', mode: 'tui', agent: 'claude' });
      f.push({ type: 'session.state', sessionId: 'sid-1', seq: 5, sessionStatus: 'stopped', mode: 'tui', agent: 'claude' });
      f.push({ type: 'event', sessionId: 'sid-1', seq: 6, kind: 'stderr', channel: 'agent-error', payload: 'MCP: token expired' });
      f.push({ type: 'event', sessionId: 'sid-1', seq: 7, kind: 'complete', channel: 'agent-complete', payload: null });

      // The announce at start already emitted 'started'; the first push repeats it and is suppressed.
      expect(status).toEqual([{ sessionStatus: 'stopped' }]);
      expect(mode).toEqual([{ mode: 'tui' }]);
      expect(stderr).toEqual(['MCP: token expired']);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledWith();
    });

    it('renders a permission request as the legacy card payload and answers it by id', async () => {
      const api = await started();
      const out: unknown[] = [];
      api.onEvent('agent-output:tab-A', (p) => out.push(p));
      const cardPayload = { type: 'permission_request', request_id: 'req-9', tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [] };
      f.push({ type: 'permission.request', sessionId: 'sid-1', seq: 3, permissionId: 'req-9', tool: 'Bash', input: { command: 'ls' }, payload: cardPayload });
      expect(out).toEqual([cardPayload]);

      await api.invoke('session_respond_permission', { tabId: 'tab-A', behavior: 'allow', updatedInput: { command: 'ls -la' }, updatedPermissions: [{ type: 'addRules' }] });
      expect(f.requests.at(-1)).toEqual({
        method: 'permission.respond',
        params: { sessionId: 'sid-1', permissionId: 'req-9', decision: 'allow', updatedInput: { command: 'ls -la' }, remember: [{ type: 'addRules' }] },
      });
      await expect(api.invoke('session_respond_permission', { tabId: 'tab-A', behavior: 'deny' })).rejects.toThrow('[PERMISSION_NOT_PENDING]');
    });

    it('routes a notification to the global channel with the renderer\'s tabId and raises a native notification', async () => {
      const api = await started();
      const seen: unknown[] = [];
      api.onEvent('claude-notification', (p) => seen.push(p));
      f.push({ type: 'event', sessionId: 'sid-1', seq: 3, kind: 'notification', channel: 'claude-notification', payload: { tab_id: 'sid-1', title: 'OmniFex — x', body: 'done', is_error: false } });
      expect(seen).toEqual([{ tab_id: 'tab-A', title: 'OmniFex — x', body: 'done', is_error: false }]);
      expect(native.invoke).toHaveBeenCalledWith('notify:show', { title: 'OmniFex — x', body: 'done', isError: false, tabId: 'tab-A' });
    });

    it('re-emits app-wide channel broadcasts under their own names', async () => {
      const api = shim();
      const seen: unknown[] = [];
      api.onEvent('rate-limits:updated', (p) => seen.push(p));
      f.push({ type: 'channel', channel: 'rate-limits:updated', payload: { accountName: 'P' } });
      expect(seen).toEqual([{ accountName: 'P' }]);
    });
  });

  describe('invoke routing', () => {
    it('sends native-only channels to the preload bridge, and rejects them on the web', async () => {
      const api = shim();
      expect(await api.invoke('dialog:open', { properties: ['openDirectory'] })).toBe('native-result');
      expect(native.invoke).toHaveBeenCalledWith('dialog:open', { properties: ['openDirectory'] });
      expect(f.requests).toEqual([]);

      const web = createElectronApiShim({ client: f.client, native: null, storage });
      await expect(web.invoke('reveal_path_in_finder', { path: '/x' })).rejects.toThrow(/not available in the web client/);
    });

    it('passes everything else through rpc.invoke, rewriting a tabId on session_* channels', async () => {
      const api = shim();
      await api.invoke('session_start', { tabId: 'tab-A', projectPath: '/p', model: 'default', permissionMode: 'default' });
      f.requests.length = 0;

      expect(await api.invoke('list_accounts')).toEqual({ rpc: 'list_accounts', params: {} });
      expect(await api.invoke('session_set_model', { tabId: 'tab-A', model: 'opus' })).toEqual({ rpc: 'session_set_model', params: { tabId: 'sid-1', model: 'opus' } });
      // A CLI sessionId param is not a tabId and is left alone.
      expect(await api.invoke('session_cost_watch', { sessionId: 'sid-1', configDir: '/c', projectPath: '/p', accountName: 'a' })).toMatchObject({ params: { sessionId: 'sid-1' } });
    });

    it('turns text and structured sends into turn.send, and stop into kill + unmap', async () => {
      const api = shim();
      await api.invoke('session_start', { tabId: 'tab-A', projectPath: '/p', model: 'default', permissionMode: 'default' });
      await api.invoke('session_send_message', { tabId: 'tab-A', prompt: 'hi' });
      await api.invoke('session_send_structured_message', { tabId: 'tab-A', content: [{ type: 'text', text: 'x' }] });
      expect(f.requests.slice(-2)).toEqual([
        { method: 'turn.send', params: { sessionId: 'sid-1', content: 'hi' } },
        { method: 'turn.send', params: { sessionId: 'sid-1', content: [{ type: 'text', text: 'x' }] } },
      ]);
      await api.invoke('session_stop', { tabId: 'tab-A' });
      expect(f.requests.at(-1)).toEqual({ method: 'session.kill', params: { sessionId: 'sid-1' } });
      expect(JSON.parse(storage.getItem(TAB_MAP_STORAGE_KEY)!)).toEqual({});
      await expect(api.invoke('session_send_message', { tabId: 'tab-A', prompt: 'x' })).rejects.toThrow('[SESSION_NOT_RUNNING]');
    });
  });

  describe('reload and reconnect', () => {
    it('rebinds a tab from the persisted map by resuming and subscribing', async () => {
      storage.setItem(TAB_MAP_STORAGE_KEY, JSON.stringify({ 'tab-A': 'sid-1' }));
      f.responders['session.resume'] = () => summary('sid-1', { lastSeq: 40 });
      const api = shim();
      expect(await api.invoke('session_rebind', { tabId: 'tab-A' })).toBe(true);
      expect(f.requests.map((r) => r.method)).toEqual(['session.resume', 'session.subscribe']);
      expect(await api.invoke('session_rebind', { tabId: 'unknown' })).toBe(false);
    });

    it('forgets a mapped tab whose session the daemon no longer has', async () => {
      storage.setItem(TAB_MAP_STORAGE_KEY, JSON.stringify({ 'tab-A': 'sid-gone' }));
      f.responders['session.resume'] = () => { throw Object.assign(new Error('x'), { code: 'NOT_FOUND' }); };
      const api = shim();
      expect(await api.invoke('session_rebind', { tabId: 'tab-A' })).toBe(false);
      expect(JSON.parse(storage.getItem(TAB_MAP_STORAGE_KEY)!)).toEqual({});
    });

    it('resubscribes every live session from its last seen seq after a reconnect and reports the gap', async () => {
      const api = shim();
      const caught: unknown[] = [];
      const conn: unknown[] = [];
      api.onEvent('remote-caught-up:tab-A', (p) => caught.push(p));
      api.onEvent('remote-connection', (p) => conn.push(p));
      await api.invoke('session_start', { tabId: 'tab-A', projectPath: '/p', model: 'default', permissionMode: 'default' });
      f.push({ type: 'event', sessionId: 'sid-1', seq: 7, kind: 'transcript', channel: 'agent-output', payload: { raw: {} } });
      f.requests.length = 0;

      f.setState('connected'); // first connect: nothing to redo
      expect(f.requests).toEqual([]);
      f.setState('reconnecting');
      f.responders['session.subscribe'] = (p) => ({ fromSeq: p.fromSeq, lastSeq: 12 });
      f.setState('connected');
      await new Promise((r) => setTimeout(r, 0));
      expect(f.requests).toEqual([{ method: 'session.subscribe', params: { sessionId: 'sid-1', fromSeq: 7 } }]);
      expect(caught).toEqual([{ events: 5 }]);
      expect(conn).toEqual([{ state: 'connected' }, { state: 'reconnecting' }, { state: 'connected' }]);
    });
  });

  it('subscribes native-origin events on the preload bridge, never the daemon', () => {
    const api = shim();
    const cb = vi.fn();
    api.onEvent('updater:progress', cb);
    api.onEvent('notification-clicked', cb);
    expect(native.onEvent).toHaveBeenCalledTimes(2);
  });
});
