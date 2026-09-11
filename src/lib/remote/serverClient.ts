/**
 * `ProtocolClient` over a browser-compatible WebSocket.
 *
 * Owns exactly the transport concerns: open, `hello`, request/response
 * correlation, reconnect with backoff, and surfacing pushes. It does not know
 * what a session is. Re-subscribing after a reconnect is the shim's job —
 * only the shim knows which sessions the UI is showing and the last seq it
 * saw for each.
 *
 * Requests made while (re)connecting are queued rather than rejected: the
 * iPad backgrounds this app constantly, and a tap that lands during the
 * half-second the socket takes to come back should not fail.
 */
import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  type ClientMethod,
  type ServerMessage,
} from '@/protocol';
import type {
  ConnectionState,
  ParamsOf,
  ProtocolClient,
  ProtocolRequestMap,
  ResultOf,
  Unsubscribe,
} from '@/protocol/interfaces';

/** The subset of the WebSocket surface this client uses — injectable for tests. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface ServerClientOptions {
  url: string;
  clientId: string;
  clientKind: 'electron' | 'web';
  /** Defaults to the global `WebSocket`. */
  createSocket?: WebSocketFactory;
  /** `false` disables reconnect; otherwise exponential backoff between the two. */
  reconnect?: { initialMs: number; maxMs: number } | false;
  /** A queued or in-flight request older than this is rejected. */
  requestTimeoutMs?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

/** Client-side failure, distinct from a daemon `ProtocolError`. */
export class RemoteClientError extends Error {
  constructor(
    readonly code: 'DISCONNECTED' | 'TIMEOUT' | 'PROTOCOL_VERSION_MISMATCH' | string,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteClientError';
  }
}

type Welcome = ProtocolRequestMap['hello']['result'];

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  /** Null for the methods that are deliberately not on a clock — see `rawRequest`. */
  timer: ReturnType<typeof setTimeout> | null;
}

const OPEN = 1;

export interface ServerClient extends ProtocolClient {
  readonly welcome: Welcome | null;
  readonly url: string;
}

export function createServerClient(opts: ServerClientOptions): ServerClient {
  const createSocket: WebSocketFactory =
    opts.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
  const reconnect = opts.reconnect === undefined ? { initialMs: 1000, maxMs: 30_000 } : opts.reconnect;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  const log = opts.log ?? (() => {});

  let state: ConnectionState = 'disconnected';
  let socket: WebSocketLike | null = null;
  let welcome: Welcome | null = null;
  let everConnected = false;
  let wantConnected = false;
  let backoffMs = reconnect ? reconnect.initialMs : 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  const pending = new Map<string, Pending>();
  /** Frames to send once the socket is open and greeted. */
  const outbox: string[] = [];
  const pushListeners = new Set<(m: ServerMessage) => void>();
  const stateListeners = new Set<(s: ConnectionState) => void>();
  let connectWaiters: Array<{ resolve: (w: Welcome) => void; reject: (e: unknown) => void }> = [];

  function setState(next: ConnectionState): void {
    if (state === next) return;
    state = next;
    log('state', { state: next });
    for (const l of stateListeners) {
      try {
        l(next);
      } catch (err) {
        console.error('[remote] state listener failed:', err);
      }
    }
  }

  function failAll(reason: RemoteClientError): void {
    for (const [id, p] of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(reason);
      pending.delete(id);
    }
    outbox.length = 0;
    for (const w of connectWaiters.splice(0)) w.reject(reason);
  }

  function flushOutbox(): void {
    if (!socket || socket.readyState !== OPEN) return;
    for (const frame of outbox.splice(0)) socket.send(frame);
  }

  function sendFrame(frame: string, immediate: boolean): void {
    if (immediate && socket && socket.readyState === OPEN) socket.send(frame);
    else outbox.push(frame);
  }

  function rawRequest<T>(method: string, params: Record<string, unknown>, immediate: boolean): Promise<T> {
    if (state === 'disconnected' && !wantConnected) {
      return Promise.reject(new RemoteClientError('DISCONNECTED', `not connected (${method})`));
    }
    const requestId = `c${++seq}`;
    return new Promise<T>((resolve, reject) => {
      // The protocol's own methods answer promptly or not at all, so a clock
      // on them turns a wedged daemon into an error instead of a spinner.
      //
      // `rpc.invoke` is the exception, and it is not a small one: it proxies an
      // arbitrary IPC handler, and on the desktop those have no deadline at
      // all. Indexing nine sessions into the Brain takes a minute, a backfill
      // takes hours — and rejecting at 30s did not stop any of it, it only
      // stopped the UI hearing how it ended. The call then reported
      // "rpc.invoke timed out after 30000ms" over work that went on to finish
      // and bill, with no completion refresh behind it. The socket is the
      // honest liveness signal, and `onclose` below already fails everything
      // in flight on it.
      const timer =
        method === 'rpc.invoke'
          ? null
          : setTimeout(() => {
              pending.delete(requestId);
              reject(new RemoteClientError('TIMEOUT', `${method} timed out after ${requestTimeoutMs}ms`));
            }, requestTimeoutMs);
      pending.set(requestId, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      sendFrame(JSON.stringify({ type: method, requestId, ...params }), immediate);
    });
  }

  function handleFrame(data: unknown): void {
    let raw: unknown;
    try {
      raw = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      log('non-JSON frame dropped');
      return;
    }
    const decoded = decodeServerMessage(raw);
    if (!decoded.ok) {
      log('undecodable frame dropped', { error: decoded.error.message.slice(0, 200) });
      return;
    }
    const m = decoded.message;
    if (m.type === 'response') {
      const p = pending.get(m.requestId);
      if (!p) return;
      pending.delete(m.requestId);
      if (p.timer) clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
      return;
    }
    for (const l of pushListeners) {
      try {
        l(m);
      } catch (err) {
        console.error('[remote] push listener failed:', err);
      }
    }
  }

  function scheduleReconnect(): void {
    if (!reconnect || !wantConnected || reconnectTimer) return;
    setState('reconnecting');
    const delay = backoffMs;
    backoffMs = Math.min(reconnect.maxMs, backoffMs * 2);
    log('reconnect scheduled', { delayMs: delay });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (wantConnected) open();
    }, delay);
  }

  function open(): void {
    if (state !== 'reconnecting') setState('connecting');
    let ws: WebSocketLike;
    try {
      ws = createSocket(opts.url);
    } catch (err) {
      log('socket construction failed', { error: String(err) });
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      // `hello` goes first, ahead of anything queued while we were down.
      rawRequest<Welcome>(
        'hello',
        { clientId: opts.clientId, clientKind: opts.clientKind, protocolVersion: PROTOCOL_VERSION },
        true,
      )
        .then((w) => {
          welcome = w;
          everConnected = true;
          backoffMs = reconnect ? reconnect.initialMs : 0;
          setState('connected');
          flushOutbox();
          for (const waiter of connectWaiters.splice(0)) waiter.resolve(w);
        })
        .catch((err: unknown) => {
          const code = (err as { code?: string }).code;
          if (code === 'PROTOCOL_VERSION_MISMATCH') {
            // No point retrying: this client cannot talk to that daemon.
            wantConnected = false;
            failAll(new RemoteClientError('PROTOCOL_VERSION_MISMATCH', (err as Error).message));
            setState('disconnected');
            return;
          }
          log('hello failed', { error: String(err) });
          ws.close();
        });
    };
    ws.onmessage = (ev) => handleFrame(ev.data);
    ws.onerror = () => {
      // `onclose` always follows; nothing to do here but note it.
      log('socket error');
    };
    ws.onclose = (ev) => {
      if (socket !== ws) return;
      socket = null;
      log('socket closed', { code: ev.code, reason: ev.reason });
      // In-flight requests cannot be answered by the next socket: the daemon
      // never saw them or has no way to route the reply. Fail them now.
      for (const [id, p] of pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new RemoteClientError('DISCONNECTED', `${p.method}: connection lost`));
        pending.delete(id);
      }
      if (wantConnected && reconnect) {
        scheduleReconnect();
      } else {
        setState('disconnected');
        for (const w of connectWaiters.splice(0)) {
          w.reject(new RemoteClientError('DISCONNECTED', `connection closed (${ev.code})`));
        }
      }
    };
  }

  return {
    get state() {
      return state;
    },
    get welcome() {
      return welcome;
    },
    get url() {
      return opts.url;
    },

    connect() {
      wantConnected = true;
      if (state === 'connected' && welcome) return Promise.resolve(welcome);
      const p = new Promise<Welcome>((resolve, reject) => connectWaiters.push({ resolve, reject }));
      if (state === 'disconnected') open();
      return p;
    },

    disconnect() {
      wantConnected = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const ws = socket;
      socket = null;
      failAll(new RemoteClientError('DISCONNECTED', 'client disconnected'));
      ws?.close(1000, 'client disconnect');
      setState('disconnected');
    },

    request<M extends ClientMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
      return rawRequest<ResultOf<M>>(method, params as Record<string, unknown>, state === 'connected');
    },

    onPush(listener): Unsubscribe {
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    },

    onStateChange(listener): Unsubscribe {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };

  // `everConnected` is read by nothing yet but kept for the reconnect banner
  // (Phase 5): the first connect and a re-connect deserve different copy.
  void everConnected;
}
