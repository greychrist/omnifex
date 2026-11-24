// A tab-scoped suffix that names no open session is an app-wide signal: it goes out as a `channel` broadcast.
import { IDLE_TURN, type SendToRenderer, type TurnState } from '../services/sessions/types';
import type { JsonlNode } from '../../src/types/jsonl';
import type { ServerMessage, SessionScopedPush, SessionStatus } from '../../src/protocol';
import type { SessionLog, UnsequencedPush } from './session-log';

export interface SessionBridgeDeps {
  log: SessionLog;
  /** Injected: this module must stay free of `@/` imports. */
  classify: (raw: unknown) => JsonlNode | null;
  publish: (push: SessionScopedPush) => void;
  broadcast: (message: Extract<ServerMessage, { type: 'channel' }>) => void;
}

export interface SessionControlState {
  sessionStatus: SessionStatus;
  turn: TurnState;
  error?: string;
}

export interface SessionBridge {
  sendToRenderer: SendToRenderer;
  pendingPermissions(sessionId: string): string[];
  permissionAnswered(sessionId: string, permissionId: string): void;
  state(sessionId: string): SessionControlState | null;
  forget(sessionId: string): void;
}

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

function isWithdrawnPayload(payload: unknown): payload is { type: 'permission_withdrawn'; request_id: string } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: unknown }).type === 'permission_withdrawn'
  );
}

export function createSessionBridge(deps: SessionBridgeDeps): SessionBridge {
  const states = new Map<string, SessionControlState>();
  const pending = new Map<string, string[]>();

  function stateFor(sessionId: string): SessionControlState {
    let s = states.get(sessionId);
    if (!s) {
      s = { sessionStatus: 'starting', turn: IDLE_TURN };
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
    const push = deps.log.append({
      type: 'session.state',
      sessionId,
      sessionStatus: s.sessionStatus,
      agent: meta?.agent ?? 'claude',
      turn: { ...s.turn },
      ...(s.error !== undefined && { error: s.error }),
    });
    deps.publish(push);
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
    // Never drop a frame the classifier cannot place.
    const node =
      deps.classify(raw) ??
      ({ kind: 'unknown', raw: raw as Record<string, unknown>, sessionId, receivedAt: null });
    emitEvent(sessionId, 'transcript', channel, node, { origin });
  }

  function permission(sessionId: string, payload: Record<string, unknown>): void {
    const rawId: unknown = payload.request_id ?? payload.requestId ?? '';
    const permissionId = String(rawId);
    const toolName: unknown = payload.tool_name ?? 'unknown';
    const kind = payload.kind === 'patch' || payload.kind === 'exec' ? payload.kind : 'tool';
    const list = pending.get(sessionId) ?? [];
    if (!list.includes(permissionId)) list.push(permissionId);
    pending.set(sessionId, list);
    emit({
      type: 'permission.request',
      sessionId,
      permissionId,
      tool: String(toolName),
      input: (payload.tool_input) ?? {},
      kind,
      ...(Array.isArray(payload.permission_suggestions) && { suggestions: payload.permission_suggestions }),
      payload,
    });
  }

  function withdrawn(sessionId: string, channel: string, payload: { request_id: string }): void {
    const list = pending.get(sessionId);
    const i = list?.indexOf(String(payload.request_id)) ?? -1;
    if (list && i >= 0) list.splice(i, 1);
    emitEvent(sessionId, 'permission-withdrawn', channel, payload);
  }

  const sendToRenderer: SendToRenderer = (channel, ...args) => {
    const payload = args[0];
    const { prefix, suffix } = splitChannel(channel);

    if (prefix === 'claude-notification' && suffix === null) {
      const tabId = (payload as { tab_id?: unknown } | undefined)?.tab_id;
      if (typeof tabId === 'string' && deps.log.isOpen(tabId)) {
        emitEvent(tabId, 'notification', prefix, payload);
        return;
      }
      deps.broadcast({ type: 'channel', channel, payload });
      return;
    }

    // `session-cost:<id>` names the CLI session UUID, not a tab; its listener uses exactly that name.
    if (prefix === 'session-cost' || suffix === null || !deps.log.isOpen(suffix)) {
      deps.broadcast({ type: 'channel', channel, payload });
      return;
    }
    const sessionId = suffix;

    switch (prefix) {
      case 'agent-output':
        if (isPermissionPayload(payload)) permission(sessionId, payload);
        else if (isWithdrawnPayload(payload)) withdrawn(sessionId, prefix, payload);
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
      case 'session-turn': {
        // Never infer the turn from the transcript: the session announces it.
        const turn = payload as TurnState | undefined;
        if (turn && (turn.status === 'idle' || turn.status === 'running')) {
          stateFor(sessionId).turn = { status: turn.status, since: turn.since ?? null };
        }
        emitState(sessionId);
        return;
      }

      case 'session-init':
        emitEvent(sessionId, 'init', prefix, payload);
        return;
      case 'session-account-mismatch':
        emitEvent(sessionId, 'account-mismatch', prefix, payload);
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
        // Unmapped tab-scoped channel: never dropped.
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
