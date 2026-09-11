/**
 * A `window.electronAPI` that talks to the daemon.
 *
 * The renderer funnels every main-process call through
 * `window.electronAPI.invoke(channel, params)` and every subscription through
 * `window.electronAPI.onEvent(channel, cb)`, with channel names from the
 * Electron IPC era. Rather than touch the ~230 call sites, this object keeps
 * that surface and changes what is behind it:
 *
 *  - session lifecycle channels become the typed protocol methods;
 *  - everything else becomes `rpc.invoke`, except channels that only Electron
 *    can serve, which go to the preload bridge when there is one;
 *  - protocol pushes are re-emitted on the legacy channel names the renderer
 *    already subscribes to, with the daemon's `sessionId` mapped back to the
 *    renderer's `tabId`.
 *
 * The tabId ⇄ sessionId map is the one piece of state. It is persisted so a
 * reload can re-attach (`session_rebind` → `session.resume`).
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

export interface ShimOptions {
  client: ProtocolClient;
  /** The preload bridge in Electron; null on the web. */
  native: NativeBridge | null;
  storage?: StorageLike | null;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  /** Web only: raise a browser Notification for a daemon-side notification. */
  webNotify?: (title: string, body: string) => void;
}

export const TAB_MAP_STORAGE_KEY = 'omnifex.remote.tabSessions';

/** Legacy tab-scoped channel prefixes the daemon turns into session pushes. */
const SESSION_EVENT_PREFIXES = new Set([
  'agent-output',
  'agent-error',
  'agent-complete',
  'claude-output-extra',
  'session-status',
  'session-init',
  'session-mode',
  'session-control-state',
  'session-account-mismatch',
  'session-tui-data',
  'session-tui-exit',
  'elicitation-request',
]);

/** Channels the shim answers with a typed method rather than rpc.invoke. */
const TYPED = new Set([
  'session_start',
  'session_rebind',
  'session_send_message',
  'session_send_structured_message',
  'session_respond_permission',
  'session_stop',
  'session_interrupt',
]);

/**
 * Baked in by `vite.web.config.ts`. The Electron renderer defines nothing
 * here — it has main to ask — so the guard is the desktop path, not a
 * defensive branch.
 */
declare const __APP_VERSION__: string | undefined;
const BUILD_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'web';

/**
 * Native-only channels the renderer calls unprompted at boot or on a timer.
 * On the web these have a benign answer rather than an error: the Updates
 * button reads "up to date", the tab-status popover is simply empty, and
 * nothing logs a red stack for a capability that was never going to exist.
 * Channels absent from this table still reject, loudly, so a real gap shows.
 */
const WEB_FALLBACKS: Record<string, unknown> = {
  'tab_status_list': [],
  'tab_status_publish': null,
  'tab_status_remove': null,
  'updater:check': null,
  // The daemon served this page, so the page has a version: the build it came
  // from. The popover compares it against the daemon's.
  'get_app_version': BUILD_VERSION,
  // No local codex on the tablet; `null` is api.ts's "not installed".
  'codex_binary_path': null,
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

export function createElectronApiShim(opts: ShimOptions): ElectronApiLike & { dispose(): void } {
  const { client, native } = opts;
  const log = opts.log ?? (() => {});
  const storage = opts.storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : opts.storage;

  // ---------------------------------------------------------------- tab map
  const tabToSession = new Map<string, string>();
  const sessionToTabs = new Map<string, Set<string>>();
  const lastSeq = new Map<string, number>();
  const pendingPermission = new Map<string, string>();
  const lastState = new Map<string, { sessionStatus?: string; mode?: string }>();

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
    if (tabs && tabs.size === 0) {
      sessionToTabs.delete(sid);
      lastSeq.delete(sid);
      pendingPermission.delete(sid);
      lastState.delete(sid);
    }
    if (persist) saveMap();
  }
  loadMap();

  // -------------------------------------------------------------- listeners
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

  function emitForSession(sessionId: string, prefix: string, ...args: unknown[]): void {
    const tabs = sessionToTabs.get(sessionId);
    if (!tabs) return;
    for (const tab of tabs) emit(`${prefix}:${tab}`, ...args);
  }

  function notifyNative(title: string, body: string, isError: boolean, tabId: string | null): void {
    if (native) {
      void native.invoke('notify:show', { title, body, isError, tabId }).catch(() => {});
    } else {
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
        } else if (m.kind === 'notification' && prefix === 'claude-notification') {
          const tabs = sessionToTabs.get(m.sessionId);
          const p = (m.payload ?? {}) as { title?: string; body?: string; is_error?: boolean };
          for (const tab of tabs ?? []) {
            emit('claude-notification', { ...(m.payload as Record<string, unknown>), tab_id: tab });
            notifyNative(p.title ?? 'OmniFex', p.body ?? '', !!p.is_error, tab);
          }
        } else {
          // `notification` is two things on the wire: the OS-notification
          // channel above, and the bridge's catch-all for any tab-scoped
          // channel it has no case for (`session-cost` today —
          // electron/remote/bridge.ts). Routing the catch-all by kind rang
          // the notification sound on every cost tick, with an empty body
          // and no banner when the window was focused, and starved
          // `useSessionCost` of the updates it was actually carrying.
          // Branch on the channel, which every push carries.
          emitForSession(m.sessionId, prefix, m.payload);
        }
        return;
      }
      case 'session.state': {
        lastSeq.set(m.sessionId, m.seq);
        const prev = lastState.get(m.sessionId) ?? {};
        if (prev.sessionStatus !== m.sessionStatus) emitForSession(m.sessionId, 'session-status', { sessionStatus: m.sessionStatus });
        if (prev.mode !== m.mode) emitForSession(m.sessionId, 'session-mode', { mode: m.mode });
        lastState.set(m.sessionId, { sessionStatus: m.sessionStatus, mode: m.mode });
        return;
      }
      case 'permission.request': {
        lastSeq.set(m.sessionId, m.seq);
        pendingPermission.set(m.sessionId, m.permissionId);
        // The daemon carried the renderer's own card payload whole.
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

  // ---------------------------------------------------------- reconnection
  let wasConnected = false;
  const unsubState = client.onStateChange((s: ConnectionState) => {
    emit('remote-connection', { state: s });
    if (s === 'connected') {
      if (wasConnected) void resubscribeAll();
      wasConnected = true;
    }
  });

  async function resubscribeAll(): Promise<void> {
    for (const sessionId of sessionToTabs.keys()) {
      // Only the tab map survives a reload; `lastSeq` does not. A restored
      // tab that has not rebound yet therefore has no seq, and asking for
      // `fromSeq: 0` made the daemon replay its ENTIRE log — every
      // transcript row a second time, and one notification per logged
      // notification event. Unknown means live-only, the same call
      // `startSession` makes: the renderer loads its own history from disk.
      const from = lastSeq.get(sessionId);
      try {
        const r = await client.request('session.subscribe', from === undefined ? { sessionId } : { sessionId, fromSeq: from });
        if (from === undefined) lastSeq.set(sessionId, r.lastSeq);
        const caughtUp = from === undefined ? 0 : Math.max(0, r.lastSeq - from);
        for (const tab of sessionToTabs.get(sessionId) ?? []) emit(`remote-caught-up:${tab}`, { events: caughtUp });
      } catch (err) {
        log('resubscribe failed', { sessionId, error: String(err) });
      }
    }
    // Replay covers what the daemon logged. It does not cover the daemon
    // itself having restarted, which kills every CLI child without a
    // `stopped` ever being written. Reconcile against what it reports now so
    // the badge is honest and the next send takes the renderer's own
    // stopped → resume path.
    try {
      const summaries = await client.request('session.list', {});
      for (const summary of summaries) {
        if (!sessionToTabs.has(summary.sessionId)) continue;
        const prev = lastState.get(summary.sessionId);
        if (prev?.sessionStatus === summary.sessionStatus) continue;
        const diedWithDaemon =
          summary.sessionStatus === 'stopped' &&
          (prev?.sessionStatus === 'started' || prev?.sessionStatus === 'starting');
        lastState.set(summary.sessionId, { sessionStatus: summary.sessionStatus, mode: summary.mode });
        emitForSession(summary.sessionId, 'session-status', { sessionStatus: summary.sessionStatus });
        // A session this client had live and the daemon no longer has: its
        // CLI child went down with the daemon. Say so on its own channel so
        // the tab can resume itself — the renderer owns that, because
        // reviving the CLI without re-attaching the tab's stream listeners
        // would leave an invisible session burning tokens. Only sessions
        // that were actually live are announced; a tab that was already
        // stopped stays stopped, as at launch.
        if (diedWithDaemon) emitForSession(summary.sessionId, 'remote-session-died', { sessionId: summary.sessionId });
      }
    } catch (err) {
      log('post-reconnect reconcile failed', { error: String(err) });
    }
  }

  // ------------------------------------------------------------ session ops
  function announce(tabId: string, summary: SessionSummary, projectPath: string): void {
    lastState.set(summary.sessionId, { sessionStatus: summary.sessionStatus, mode: summary.mode });
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
      thinking: p.thinking,
      mode: p.mode,
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
        // A transcript the daemon never saw (started by the desktop app before
        // the daemon existed, or by `claude` in a terminal). Adopt it.
        summary = await client.request('session.create', {
          projectId: project.projectId,
          options: { ...options, resumeSessionId: resumeId },
        });
      }
    } else {
      summary = await client.request('session.create', { projectId: project.projectId, options });
    }
    link(tabId, summary.sessionId);
    // Live only. The renderer loads what is already on disk through
    // `load_session_history`; replaying the log here would double every row.
    await client.request('session.subscribe', { sessionId: summary.sessionId });
    lastSeq.set(summary.sessionId, summary.lastSeq);
    announce(tabId, summary, projectPath);
  }

  async function rebind(tabId: string): Promise<boolean> {
    const sessionId = tabToSession.get(tabId);
    if (!sessionId) return false;
    try {
      const summary = await client.request('session.resume', { sessionId });
      await client.request('session.subscribe', { sessionId });
      lastSeq.set(sessionId, summary.lastSeq);
      lastState.set(sessionId, { sessionStatus: summary.sessionStatus, mode: summary.mode });
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'NOT_FOUND') {
        unlink(tabId);
        return false;
      }
      throw err;
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
      case 'session_send_message':
        await client.request('turn.send', { sessionId: requireSession(p.tabId), content: String(p.prompt ?? p.message ?? '') });
        return null;
      case 'session_send_structured_message':
        await client.request('turn.send', {
          sessionId: requireSession(p.tabId),
          content: (p.content as Array<Record<string, unknown>>) ?? [],
        });
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
          ...(p.updatedPermissions !== undefined && { remember: p.updatedPermissions as Array<Record<string, unknown>> }),
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
      case 'session_interrupt':
        await client.request('turn.interrupt', { sessionId: requireSession(p.tabId) });
        return null;
      default:
        throw new Error(`unhandled typed channel ${channel}`);
    }
  }

  // --------------------------------------------------------------- surface
  const api: ElectronApiLike & { dispose(): void } = {
    async invoke(channel, params) {
      const p = params ?? {};
      try {
        if (NATIVE_INVOKE_CHANNELS.includes(channel)) {
          if (!native) {
            if (channel in WEB_FALLBACKS) return WEB_FALLBACKS[channel];
            throw new Error(`${channel} is not available in the web client`);
          }
          return await native.invoke(channel, p);
        }
        if (TYPED.has(channel)) return await typed(channel, p);
        // Other session_* channels are tabId-keyed on the daemon too, where
        // tabId === sessionId. Rewrite; leave params that carry a CLI
        // sessionId (`session_cost_*`, `session_subagent_meta`) alone.
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
        set!.delete(callback);
        if (set!.size === 0) listeners.delete(channel);
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

    dispose() {
      unsubPush();
      unsubState();
      listeners.clear();
    },
  };

  void SESSION_EVENT_PREFIXES; // documented above; routing is by push, not by subscription
  return api;
}
