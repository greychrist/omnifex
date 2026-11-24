/**
 * `window.electronAPI` over the daemon: session channels become typed protocol methods, everything else `rpc.invoke` (native-only ones go to the bridge),
 * and pushes are re-emitted on the legacy channel names with the daemon's `sessionId` mapped back to the renderer's `tabId`.
 */
import type { ProtocolClient, ConnectionState } from '@/protocol/interfaces';
import type { ServerMessage, SessionSummary } from '@/protocol';
import { isNativeEventChannel, NATIVE_INVOKE_CHANNELS } from '@/lib/remote/nativeChannels';
import type { NativeBridge } from '@/lib/platform';

export interface ElectronApiLike {
  invoke(channel: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(channel: string, callback: (...args: unknown[]) => void): () => void;
  showOpenDialog(options: Record<string, unknown>): Promise<unknown>;
  showSaveDialog(options: Record<string, unknown>): Promise<unknown>;
  openExternal(url: string): Promise<void>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface NotificationPayload {
  title?: string;
  body?: string;
  is_error?: boolean;
  subtitle?: string;
  id?: string;
  deliver_at?: number;
}

export interface ShimOptions {
  client: ProtocolClient;
  native: NativeBridge | null;
  storage?: StorageLike | null;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  webNotify?: (title: string, body: string) => void;
}

export const TAB_MAP_STORAGE_KEY = 'omnifex.remote.tabSessions';

// Tab-scoped channels route by push, not by subscription, so the shim needs no table of them.

const TYPED = new Set([
  'session_start',
  'session_rebind',
  'session_send_message',
  'session_send_structured_message',
  'session_respond_permission',
  'session_stop',
  'session_release',
  'session_interrupt',
]);

/** Baked in by `vite.web.config.ts` and vitest; the dev server defines none, and that path is the guard. */
declare const __APP_VERSION__: string | undefined;
const BUILD_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'web';

/** Native-only channels called at boot or on a timer: on the web they get a benign answer, not an error. Absent channels still reject. */
const WEB_FALLBACKS: Record<string, unknown> = {
  'updater:check': null,
  'get_app_version': BUILD_VERSION,
  'drop:paths': [],
};

/** The IPC layer's error encoding, which `apiAdapter.decodeApiError` reverses. */
function ipcError(err: unknown): Error {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return new Error(typeof code === 'string' && code ? `[${code}] ${message}` : message);
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

export type ShimHandle = ElectronApiLike & {
  dispose(): void;
  isSessionSubscribed(sessionId: string): boolean;
};

export function createElectronApiShim(opts: ShimOptions): ShimHandle {
  const { client, native } = opts;
  const log = opts.log ?? (() => {});
  const storage = opts.storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : opts.storage;

  const tabToSession = new Map<string, string>();
  const sessionToTabs = new Map<string, Set<string>>();
  const lastSeq = new Map<string, number>();
  let bootId: string | undefined = client.welcome?.bootId;
  const pendingPermission = new Map<string, string>();
  const lastState = new Map<string, { sessionStatus?: string; turn?: { status: string; since: string | null } }>();
  /** Delivery is per session, not per socket: the daemon fans a session out only to clients that subscribed. */
  const subscribed = new Set<string>();

  function markSubscribed(sessionId: string, on: boolean): void {
    if (subscribed.has(sessionId) === on) return;
    if (on) subscribed.add(sessionId);
    else subscribed.delete(sessionId);
    emitForSession(sessionId, 'remote-delivery', { subscribed: on });
  }

  function loadMap(): void {
    try {
      const raw = storage?.getItem(TAB_MAP_STORAGE_KEY);
      if (!raw) return;
      for (const [tab, sid] of Object.entries(JSON.parse(raw) as Record<string, string>)) link(tab, sid, false);
    } catch {
      // A corrupt map costs a re-attach, not a session.
    }
  }
  function saveMap(): void {
    try {
      storage?.setItem(TAB_MAP_STORAGE_KEY, JSON.stringify(Object.fromEntries(tabToSession)));
    } catch {
      // Storage full or unavailable; the map just does not survive a reload.
    }
  }
  function link(tabId: string, sessionId: string, persist = true): void {
    const prev = tabToSession.get(tabId);
    if (prev && prev !== sessionId) unlink(tabId, false);
    tabToSession.set(tabId, sessionId);
    let tabs = sessionToTabs.get(sessionId);
    if (!tabs) sessionToTabs.set(sessionId, (tabs = new Set()));
    tabs.add(tabId);
    if (persist) saveMap();
  }
  function unlink(tabId: string, persist = true): void {
    const sid = tabToSession.get(tabId);
    if (!sid) return;
    tabToSession.delete(tabId);
    const tabs = sessionToTabs.get(sid);
    tabs?.delete(tabId);
    if (tabs?.size === 0) {
      sessionToTabs.delete(sid);
      lastSeq.delete(sid);
      pendingPermission.delete(sid);
      lastState.delete(sid);
      subscribed.delete(sid);
    }
    if (persist) saveMap();
  }
  loadMap();

  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  function emit(channel: string, ...args: unknown[]): void {
    const set = listeners.get(channel);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(...args);
      } catch (err) {
        console.error(`[remote-shim] listener for ${channel} threw:`, err);
      }
    }
  }

  const unroutable = new Set<string>();

  function emitForSession(sessionId: string, prefix: string, ...args: unknown[]): void {
    const tabs = sessionToTabs.get(sessionId);
    if (!tabs) {
      // Log it: silence here is indistinguishable from the daemon never sending anything.
      if (!unroutable.has(sessionId)) {
        unroutable.add(sessionId);
        log('dropping pushes for an unmapped session', { sessionId, prefix });
      }
      return;
    }
    unroutable.delete(sessionId);
    for (const tab of tabs) emit(`${prefix}:${tab}`, ...args);
  }

  /** `id` and `deliver_at` come only on a mod's notification; the web drops a delayed notice rather than raise it early. */
  function notifyNative(p: NotificationPayload, tabId: string | null): void {
    const title = p.title ?? 'OmniFex';
    const body = p.body ?? '';
    const deliverAt = typeof p.deliver_at === 'number' ? p.deliver_at : null;
    if (native) {
      void native.invoke('notify:show', {
        title, body, isError: !!p.is_error, tabId,
        ...(p.subtitle ? { subtitle: p.subtitle } : {}),
        ...(typeof p.id === 'string' ? { id: p.id } : {}),
        ...(deliverAt !== null ? { deliverAt } : {}),
      }).catch(() => {});
    } else if (deliverAt === null || deliverAt <= Date.now()) {
      opts.webNotify?.(title, body);
    }
  }

  function onPush(m: ServerMessage): void {
    switch (m.type) {
      case 'event': {
        lastSeq.set(m.sessionId, m.seq);
        const prefix = m.channel ?? m.kind;
        if (m.kind === 'transcript') {
          const raw = (m.payload as { raw?: unknown } | null)?.raw ?? m.payload;
          emitForSession(m.sessionId, prefix, raw);
        } else if (m.kind === 'complete') {
          emitForSession(m.sessionId, prefix);
        } else if (m.kind === 'permission-withdrawn') {
          const id = (m.payload as { request_id?: unknown } | null)?.request_id;
          if (pendingPermission.get(m.sessionId) === id) pendingPermission.delete(m.sessionId);
          emitForSession(m.sessionId, prefix, m.payload);
        } else if (m.kind === 'notification' && prefix === 'claude-notification') {
          const tabs = sessionToTabs.get(m.sessionId);
          const p = (m.payload ?? {}) as NotificationPayload;
          for (const tab of tabs ?? []) {
            emit('claude-notification', { ...(m.payload as Record<string, unknown>), tab_id: tab });
            notifyNative(p, tab);
          }
        } else {
          // `notification` is also the bridge's catch-all for unhandled tab-scoped channels: branch on the channel, never the kind.
          emitForSession(m.sessionId, prefix, m.payload);
        }
        return;
      }
      case 'session.state': {
        lastSeq.set(m.sessionId, m.seq);
        const prev = lastState.get(m.sessionId) ?? {};
        if (prev.sessionStatus !== m.sessionStatus) emitForSession(m.sessionId, 'session-status', { sessionStatus: m.sessionStatus });
        if (prev.turn?.status !== m.turn.status || prev.turn?.since !== m.turn.since) {
          emitForSession(m.sessionId, 'session-turn', { status: m.turn.status, since: m.turn.since });
        }
        lastState.set(m.sessionId, { sessionStatus: m.sessionStatus, turn: { status: m.turn.status, since: m.turn.since } });
        return;
      }
      case 'permission.request': {
        lastSeq.set(m.sessionId, m.seq);
        pendingPermission.set(m.sessionId, m.permissionId);
        emitForSession(m.sessionId, 'agent-output', m.payload ?? {
          type: 'permission_request',
          request_id: m.permissionId,
          tool_name: m.tool,
          tool_input: m.input,
          permission_suggestions: m.suggestions ?? [],
        });
        return;
      }
      case 'channel':
        emit(m.channel, m.payload);
        if (m.channel === 'claude-notification') {
          notifyNative((m.payload ?? {}), null);
        }
        if (m.channel === 'claude-notification-remove' && native) {
          const ids = (m.payload as { ids?: unknown } | null)?.ids;
          if (Array.isArray(ids)) void native.invoke('notify:remove', { ids }).catch(() => {});
        }
        return;
      case 'project.changed':
      case 'session.changed':
        emit(`remote:${m.type}`, m);
        return;
      default:
        return;
    }
  }

  const unsubPush = client.onPush(onPush);

  const unsubState = client.onStateChange((s: ConnectionState) => {
    emit('remote-connection', { state: s });
    if (s === 'connected') void resubscribeAll();
  });

  // Subscribe on the initial connect too, not only on reconnect: restored tabs otherwise never receive their events.
  // Live-only: the renderer loads its own history from disk, so a replay from 0 would double every row.
  if (client.state === 'connected') void resubscribeAll();

  async function resubscribeAll(): Promise<void> {
    // A different daemon run: every held seq names some other event now.
    const nowBootId = client.welcome?.bootId;
    const restarted = bootId !== undefined && nowBootId !== undefined && nowBootId !== bootId;
    if (nowBootId !== undefined) bootId = nowBootId;
    if (restarted) lastSeq.clear();

    if (sessionToTabs.size === 0) return;

    for (const sessionId of sessionToTabs.keys()) {
      // No seq means live-only: `fromSeq: 0` would replay the daemon's entire log.
      const from = lastSeq.get(sessionId);
      try {
        const r = await client.request('session.subscribe', from === undefined ? { sessionId } : { sessionId, fromSeq: from });
        markSubscribed(sessionId, true);
        if (from === undefined || r.resync) lastSeq.set(sessionId, r.lastSeq);
        if (restarted || r.resync) {
          emitForSession(sessionId, 'remote-resync', { sessionId });
          continue;
        }
        const caughtUp = from === undefined ? 0 : Math.max(0, r.lastSeq - from);
        for (const tab of sessionToTabs.get(sessionId) ?? []) emit(`remote-caught-up:${tab}`, { events: caughtUp });
      } catch (err) {
        markSubscribed(sessionId, false);
        log('resubscribe failed', { sessionId, error: String(err) });
      }
    }
    // A daemon restart kills every CLI child without writing `stopped`: reconcile against what it reports now.
    try {
      const summaries = await client.request('session.list', {});
      for (const summary of summaries) {
        if (!sessionToTabs.has(summary.sessionId)) continue;
        const prev = lastState.get(summary.sessionId);
        if (prev?.sessionStatus === summary.sessionStatus) continue;
        const diedWithDaemon =
          summary.sessionStatus === 'stopped' &&
          (prev?.sessionStatus === 'started' || prev?.sessionStatus === 'starting');
        lastState.set(summary.sessionId, { sessionStatus: summary.sessionStatus });
        emitForSession(summary.sessionId, 'session-status', { sessionStatus: summary.sessionStatus });
        // The renderer owns the resume: reviving the CLI without re-attaching the tab's listeners would leave an invisible session burning tokens.
        if (diedWithDaemon) emitForSession(summary.sessionId, 'remote-session-died', { sessionId: summary.sessionId });
      }
    } catch (err) {
      log('post-reconnect reconcile failed', { error: String(err) });
    }
  }

  function announce(tabId: string, summary: SessionSummary, projectPath: string): void {
    lastState.set(summary.sessionId, { sessionStatus: summary.sessionStatus });
    emit(`session-status:${tabId}`, { sessionStatus: summary.sessionStatus });
    emit(`session-init:${tabId}`, { sessionId: summary.sessionId, projectPath });
  }

  async function startSession(p: Record<string, unknown>): Promise<void> {
    const tabId = String(p.tabId);
    const projectPath = String(p.projectPath);
    const project = await client.request('project.add', { path: projectPath });
    const options = stripUndefined({
      model: p.model,
      permissionMode: p.permissionMode,
      effort: p.effort,
      agent: p.agent,
      configDir: p.configDir,
      manualAccountOverride: p.manualAccountOverride,
    });
    const resumeId = typeof p.resumeSessionId === 'string' && p.resumeSessionId ? p.resumeSessionId : null;

    let summary: SessionSummary;
    if (resumeId) {
      try {
        summary = await client.request('session.resume', { sessionId: resumeId });
      } catch (err) {
        if ((err as { code?: string }).code !== 'NOT_FOUND') throw err;
        summary = await client.request('session.create', {
          projectId: project.projectId,
          options: { ...options, resumeSessionId: resumeId },
        });
      }
    } else {
      summary = await client.request('session.create', { projectId: project.projectId, options });
    }
    link(tabId, summary.sessionId);
    // Live only: the renderer loads history via `load_session_history`; a replay would double every row.
    await client.request('session.subscribe', { sessionId: summary.sessionId });
    markSubscribed(summary.sessionId, true);
    lastSeq.set(summary.sessionId, summary.lastSeq);
    announce(tabId, summary, projectPath);
  }

  async function rebind(tabId: string): Promise<boolean> {
    const sessionId = tabToSession.get(tabId);
    if (!sessionId) return false;
    try {
      const summary = await client.request('session.resume', { sessionId });
      await client.request('session.subscribe', { sessionId });
      markSubscribed(sessionId, true);
      lastSeq.set(sessionId, summary.lastSeq);
      lastState.set(sessionId, { sessionStatus: summary.sessionStatus });
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'NOT_FOUND') {
        unlink(tabId);
        return false;
      }
      throw err;
    }
  }

  /** A daemon swap ends every CLI process: on SESSION_NOT_RUNNING, rebind and retry once. */
  async function sendTurn(tabId: unknown, content: string | Record<string, unknown>[]): Promise<void> {
    const sessionId = requireSession(tabId);
    try {
      await client.request('turn.send', { sessionId, content });
    } catch (err) {
      if ((err as { code?: string }).code !== 'SESSION_NOT_RUNNING') throw err;
      if (!(await rebind(String(tabId)).catch(() => false))) throw err;
      await client.request('turn.send', { sessionId, content });
    }
  }

  function requireSession(tabId: unknown): string {
    const sid = tabToSession.get(String(tabId));
    if (!sid) throw Object.assign(new Error(`no session for tab ${String(tabId)}`), { code: 'SESSION_NOT_RUNNING' });
    return sid;
  }

  async function typed(channel: string, p: Record<string, unknown>): Promise<unknown> {
    switch (channel) {
      case 'session_start':
        await startSession(p);
        return null;
      case 'session_rebind':
        return rebind(String(p.tabId));
      case 'session_send_message': {
        const prompt = (p.prompt ?? p.message ?? '') as string;
        await sendTurn(p.tabId, String(prompt));
        return null;
      }
      case 'session_send_structured_message':
        await sendTurn(p.tabId, (p.content as Record<string, unknown>[]) ?? []);
        return null;
      case 'session_respond_permission': {
        const sessionId = requireSession(p.tabId);
        const permissionId = pendingPermission.get(sessionId);
        if (!permissionId) {
          throw Object.assign(new Error('no permission is pending'), { code: 'PERMISSION_NOT_PENDING' });
        }
        await client.request('permission.respond', {
          sessionId,
          permissionId,
          decision: p.behavior === 'allow' ? 'allow' : 'deny',
          ...(p.updatedInput !== undefined && { updatedInput: p.updatedInput as Record<string, unknown> }),
          ...(p.updatedPermissions !== undefined && { remember: p.updatedPermissions as Record<string, unknown>[] }),
        });
        pendingPermission.delete(sessionId);
        return null;
      }
      case 'session_stop': {
        const sid = tabToSession.get(String(p.tabId));
        if (!sid) return null;
        try {
          await client.request('session.kill', { sessionId: sid });
        } finally {
          unlink(String(p.tabId));
        }
        return null;
      }
      case 'session_release': {
        const tabId = String(p.tabId);
        const sid = tabToSession.get(tabId);
        if (!sid) return null;
        const lastHere = sessionToTabs.get(sid)?.size === 1;
        unlink(tabId);
        if (lastHere) await client.request('session.release', { sessionId: sid });
        return null;
      }
      case 'session_interrupt':
        await client.request('turn.interrupt', { sessionId: requireSession(p.tabId) });
        return null;
      default:
        throw new Error(`unhandled typed channel ${channel}`);
    }
  }

  const webTabStatus = new Map<string, Record<string, unknown>>();

  function webTabStatusInvoke(channel: string, p: Record<string, unknown>): unknown {
    if (channel === 'tab_status_list') return [...webTabStatus.values()];
    if (channel === 'tab_status_publish') {
      const summary = p.summary as Record<string, unknown> | undefined;
      if (typeof summary?.tabId !== 'string') throw new Error('tab_status_publish requires summary.tabId');
      webTabStatus.set(summary.tabId, summary);
    } else {
      webTabStatus.delete(String(p.tabId ?? p.tab_id));
    }
    emit('tab-status:changed', [...webTabStatus.values()]);
    return null;
  }

  const api: ShimHandle = {
    async invoke(channel, params) {
      const p = params ?? {};
      try {
        if (NATIVE_INVOKE_CHANNELS.includes(channel)) {
          if (!native) {
            if (channel.startsWith('tab_status_')) return webTabStatusInvoke(channel, p);
            if (channel in WEB_FALLBACKS) return WEB_FALLBACKS[channel];
            throw new Error(`${channel} is not available in the web client`);
          }
          return await native.invoke(channel, p);
        }
        if (TYPED.has(channel)) return await typed(channel, p);
        // Daemon tabId === sessionId; leave params carrying a CLI sessionId (`session_cost_*`, `session_subagent_meta`) alone.
        let rpcParams = p;
        if (channel.startsWith('session_') && typeof p.tabId === 'string') {
          const sid = tabToSession.get(p.tabId);
          rpcParams = sid ? { ...p, tabId: sid } : p;
        }
        return await client.request('rpc.invoke', { channel, params: rpcParams });
      } catch (err) {
        throw ipcError(err);
      }
    },

    onEvent(channel, callback) {
      if (native && isNativeEventChannel(channel)) return native.onEvent(channel, callback);
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(callback);
      return () => {
        set.delete(callback);
        if (set.size === 0) listeners.delete(channel);
      };
    },

    showOpenDialog: (o) => api.invoke('dialog:open', o),
    showSaveDialog: (o) => api.invoke('dialog:save', o),
    openExternal: async (url) => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Unsafe protocol');
      if (native) {
        await native.invoke('shell:openExternal', url as unknown as Record<string, unknown>);
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    },

    isSessionSubscribed(sessionId: string) {
      return subscribed.has(sessionId);
    },

    dispose() {
      unsubPush();
      unsubState();
      listeners.clear();
    },
  };

  return api;
}
