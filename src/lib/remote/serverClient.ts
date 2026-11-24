/** Transport only; re-subscribing after a reconnect is the shim's job. Requests made while (re)connecting are queued, not rejected. */
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
  clientKind: 'desktop' | 'web';
  createSocket?: WebSocketFactory;
  reconnect?: { initialMs: number; maxMs: number } | false;
  requestTimeoutMs?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export class RemoteClientError extends Error {
  constructor(
    readonly code: 'DISCONNECTED' | 'TIMEOUT' | 'PROTOCOL_VERSION_MISMATCH' | (string & {}),
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
  let wantConnected = false;
  let backoffMs = reconnect ? reconnect.initialMs : 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  const pending = new Map<string, Pending>();
  const outbox: string[] = [];
  const pushListeners = new Set<(m: ServerMessage) => void>();
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const connectWaiters: { resolve: (w: Welcome) => void; reject: (e: unknown) => void }[] = [];

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
    if (socket?.readyState !== OPEN) return;
    for (const frame of outbox.splice(0)) socket.send(frame);
  }

  function sendFrame(frame: string, immediate: boolean): void {
    if (immediate && socket?.readyState === OPEN) socket.send(frame);
    else outbox.push(frame);
  }

  function rawRequest<T>(method: string, params: Record<string, unknown>, immediate: boolean): Promise<T> {
    if (state === 'disconnected' && !wantConnected) {
      return Promise.reject(new RemoteClientError('DISCONNECTED', `not connected (${method})`));
    }
    const requestId = `c${++seq}`;
    return new Promise<T>((resolve, reject) => {
      // The protocol's methods are on a clock; `rpc.invoke` is not: it proxies handlers that run for hours, and `onclose` is the liveness signal.
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
          backoffMs = reconnect ? reconnect.initialMs : 0;
          setState('connected');
          flushOutbox();
          for (const waiter of connectWaiters.splice(0)) waiter.resolve(w);
        })
        .catch((err: unknown) => {
          const code = (err as { code?: string }).code;
          if (code === 'PROTOCOL_VERSION_MISMATCH') {
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
      log('socket error');
    };
    ws.onclose = (ev) => {
      if (socket !== ws) return;
      socket = null;
      log('socket closed', { code: ev.code, reason: ev.reason });
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
      return rawRequest<ResultOf<M>>(method, params, state === 'connected');
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
}
