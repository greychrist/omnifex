/**
 * Session bridge — the edge where the existing sessions service meets the
 * protocol.
 *
 * `createSessionsService` talks to its UI through one callback,
 * `sendToRenderer(channel, ...args)`, whose channel names are the Electron
 * IPC vocabulary (`agent-output:<tabId>`, `session-status:<tabId>`, …). The
 * daemon hands it THIS object's `sendToRenderer` instead of a BrowserWindow,
 * and every call becomes a sequenced protocol push. Nothing in
 * `electron/services/sessions/` changes; that is the point of adapting at the
 * edge rather than rewriting the service.
 *
 * The daemon uses the protocol's `sessionId` as the service's `tabId`, so the
 * suffix on a tab-scoped channel already IS the session id. A suffix that does
 * not name an open session (`session-summary:updated`, `session-git-changed:
 * <watchId>`) is an app-wide signal, and goes out as a `channel` broadcast —
 * the prefix alone is not evidence of scope.
 */
import type { SendToRenderer } from '../services/sessions/types';
import type { JsonlNode } from '../../src/types/jsonl';
import type { ServerMessage, SessionScopedPush, SessionStatus } from '../../src/protocol';
import type { SessionLog, UnsequencedPush } from './session-log';

export interface SessionBridgeDeps {
  log: SessionLog;
  /** `classifyJsonlLine` — injected so this module stays free of `@/` imports. */
  classify: (raw: unknown) => JsonlNode | null;
  /** Deliver a stamped push to the session's subscribers. */
  publish: (push: SessionScopedPush) => void;
  /** Deliver an app-wide message to every client. */
  broadcast: (message: Extract<ServerMessage, { type: 'channel' }>) => void;
}

export interface SessionControlState {
  sessionStatus: SessionStatus;
  mode?: 'rich' | 'tui';
  model?: string;
  permissionMode?: string;
  effort?: string;
  error?: string;
}

export interface SessionBridge {
  sendToRenderer: SendToRenderer;
  /** Permission ids shown to the user and not yet answered, oldest first. */
  pendingPermissions(sessionId: string): string[];
  /** Forget a permission the handler has successfully answered. */
  permissionAnswered(sessionId: string, permissionId: string): void;
  /** The connection axis plus the last control-state mirror, for summaries. */
  state(sessionId: string): SessionControlState | null;
  /** Drop per-session tracking once a session is gone for good. */
  forget(sessionId: string): void;
}

/** `prefix:suffix` → both halves; a channel with no colon has no suffix. */
function splitChannel(channel: string): { prefix: string; suffix: string | null } {
  const i = channel.indexOf(':');
  return i < 0 ? { prefix: channel, suffix: null } : { prefix: channel.slice(0, i), suffix: channel.slice(i + 1) };
}

function isPermissionPayload(payload: unknown): payload is Record<string, unknown> {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: unknown }).type === 'permission_request'
  );
}

export function createSessionBridge(deps: SessionBridgeDeps): SessionBridge {
  const states = new Map<string, SessionControlState>();
  const pending = new Map<string, string[]>();

  function stateFor(sessionId: string): SessionControlState {
    let s = states.get(sessionId);
    if (!s) {
      // A session the log knows but the bridge has not seen a status for is
      // still dialing — the same optimistic 'starting' the renderer assumes.
      const meta = deps.log.meta(sessionId);
      s = { sessionStatus: 'starting', mode: meta?.mode ?? 'rich' };
      states.set(sessionId, s);
    }
    return s;
  }

  function emit(push: UnsequencedPush): void {
    deps.publish(deps.log.append(push));
  }

  function emitState(sessionId: string): void {
    const s = stateFor(sessionId);
    const meta = deps.log.meta(sessionId);
    emit({
      type: 'session.state',
      sessionId,
      sessionStatus: s.sessionStatus,
      mode: s.mode ?? meta?.mode ?? 'rich',
      agent: meta?.agent ?? 'claude',
      ...(s.model !== undefined && { model: s.model }),
      ...(s.permissionMode !== undefined && { permissionMode: s.permissionMode }),
      ...(s.effort !== undefined && { effort: s.effort }),
      ...(s.error !== undefined && { error: s.error }),
    });
  }

  function emitEvent(
    sessionId: string,
    kind: string,
    channel: string,
    payload: unknown,
    extra: Record<string, unknown> = {},
  ): void {
    emit({ type: 'event', sessionId, kind, channel, payload, ...extra });
  }

  function transcript(sessionId: string, channel: string, raw: unknown, origin: 'engine' | 'tail'): void {
    // Never drop a frame the classifier cannot place: the renderer's own
    // catch-all is an `unknown` node, and a client shim re-emits `raw` anyway.
    const node =
      deps.classify(raw) ??
      ({ kind: 'unknown', raw: raw as Record<string, unknown>, sessionId, receivedAt: null } as JsonlNode);
    emitEvent(sessionId, 'transcript', channel, node, { origin });
  }

  function permission(sessionId: string, payload: Record<string, unknown>): void {
    const permissionId = String(payload.request_id ?? payload.requestId ?? '');
    const kind = payload.kind === 'patch' || payload.kind === 'exec' ? payload.kind : 'tool';
    const list = pending.get(sessionId) ?? [];
    if (!list.includes(permissionId)) list.push(permissionId);
    pending.set(sessionId, list);
    emit({
      type: 'permission.request',
      sessionId,
      permissionId,
      tool: String(payload.tool_name ?? 'unknown'),
      input: (payload.tool_input as Record<string, unknown> | undefined) ?? {},
      kind,
      ...(Array.isArray(payload.permission_suggestions) && { suggestions: payload.permission_suggestions }),
      payload,
    });
  }

  const sendToRenderer: SendToRenderer = (channel, ...args) => {
    const payload = args[0];
    const { prefix, suffix } = splitChannel(channel);

    // `claude-notification` is global on the wire but names its tab inside.
    if (prefix === 'claude-notification' && suffix === null) {
      const tabId = (payload as { tab_id?: unknown } | undefined)?.tab_id;
      if (typeof tabId === 'string' && deps.log.isOpen(tabId)) {
        emitEvent(tabId, 'notification', prefix, payload);
        return;
      }
      deps.broadcast({ type: 'channel', channel, payload });
      return;
    }

    if (suffix === null || !deps.log.isOpen(suffix)) {
      deps.broadcast({ type: 'channel', channel, payload });
      return;
    }
    const sessionId = suffix;

    switch (prefix) {
      case 'agent-output':
        if (isPermissionPayload(payload)) permission(sessionId, payload);
        else transcript(sessionId, prefix, payload, 'engine');
        return;
      case 'claude-output-extra':
        transcript(sessionId, prefix, payload, 'tail');
        return;

      case 'session-status': {
        const next = (payload as { sessionStatus?: SessionStatus } | undefined)?.sessionStatus;
        if (next) stateFor(sessionId).sessionStatus = next;
        emitState(sessionId);
        return;
      }
      case 'session-mode': {
        const mode = (payload as { mode?: 'rich' | 'tui' } | undefined)?.mode;
        if (mode) stateFor(sessionId).mode = mode;
        emitState(sessionId);
        return;
      }
      case 'session-control-state': {
        const s = stateFor(sessionId);
        const p = (payload ?? {}) as { model?: string; permissionMode?: string; effort?: string };
        if (p.model) s.model = p.model;
        if (p.permissionMode) s.permissionMode = p.permissionMode;
        if (p.effort) s.effort = p.effort;
        emitEvent(sessionId, 'control-state', prefix, payload);
        return;
      }

      case 'session-init':
        emitEvent(sessionId, 'init', prefix, payload);
        return;
      case 'session-account-mismatch':
        emitEvent(sessionId, 'account-mismatch', prefix, payload);
        return;
      case 'session-tui-data':
        emitEvent(sessionId, 'tui-data', prefix, payload);
        return;
      case 'session-tui-exit':
        emitEvent(sessionId, 'complete', prefix, payload);
        return;
      case 'agent-error':
        emitEvent(sessionId, 'stderr', prefix, payload);
        return;
      case 'agent-complete':
        emitEvent(sessionId, 'complete', prefix, payload ?? null);
        return;
      case 'elicitation-request':
        emitEvent(sessionId, 'elicitation', prefix, payload);
        return;

      default:
        // A tab-scoped channel this bridge has no mapping for. Not dropped —
        // it rides as a session event under its own prefix, so a client shim
        // can still re-emit it and a future mapping is a one-line addition.
        emitEvent(sessionId, 'notification', prefix, payload);
    }
  };

  return {
    sendToRenderer,
    pendingPermissions: (id) => [...(pending.get(id) ?? [])],
    permissionAnswered(id, permissionId) {
      const list = pending.get(id);
      if (!list) return;
      const i = list.indexOf(permissionId);
      if (i >= 0) list.splice(i, 1);
    },
    state: (id) => (deps.log.isOpen(id) ? { ...stateFor(id) } : null),
    forget(id) {
      states.delete(id);
      pending.delete(id);
    },
  };
}
