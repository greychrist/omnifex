/**
 * The two sides of the protocol, as interfaces only.
 *
 * No transport lives here on purpose. `ws`, reconnect/backoff, HTTP routes and
 * the launchd wrapper are Phase 2 concerns; keeping them out means the
 * renderer can be typed against `ProtocolClient` before a socket exists, and a
 * test double is an object literal rather than a fake server.
 */
import type {
  ClientMessage,
  ClientMethod,
  Project,
  ProtocolError,
  ServerMessage,
  SessionScopedPush,
  SessionSummary,
} from './messages';

export type Unsubscribe = () => void;

/**
 * Connection state as the UI needs to show it.
 *
 * `reconnecting` is distinct from `disconnected` because they read differently
 * to a user: one is "hold on", the other is "nothing is coming". An iPad app
 * is backgrounded constantly, so this transition is routine, not exceptional.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** Params (minus `requestId`, which the transport mints) and result per method. */
export interface ProtocolRequestMap {
  'hello': {
    params: { clientId: string; clientKind: 'electron' | 'web'; protocolVersion: number };
    result: { protocolVersion: number; daemonVersion: string; capabilities?: Record<string, unknown> };
  };
  'project.list': { params: Record<string, never>; result: Project[] };
  'project.add': { params: { path: string; title?: string }; result: Project };
  'project.remove': { params: { projectId: string }; result: void };
  'session.list': { params: { projectId?: string }; result: SessionSummary[] };
  'session.create': {
    params: { projectId: string; title?: string; options?: Record<string, unknown> };
    result: SessionSummary;
  };
  'session.resume': { params: { sessionId: string }; result: SessionSummary };
  'session.kill': { params: { sessionId: string }; result: void };
  /** Result reports where replay began, so a client can tell a gap from a no-op. */
  'session.subscribe': { params: { sessionId: string; fromSeq?: number }; result: { fromSeq: number; lastSeq: number } };
  'session.unsubscribe': { params: { sessionId: string }; result: void };
  'turn.send': {
    params: {
      sessionId: string;
      content: string | Array<Record<string, unknown>>;
      attachments?: Array<{ name: string; mimeType: string; dataBase64: string }>;
    };
    result: void;
  };
  'turn.interrupt': { params: { sessionId: string }; result: void };
  'permission.respond': {
    params: {
      sessionId: string;
      permissionId: string;
      decision: 'allow' | 'deny';
      updatedInput?: Record<string, unknown>;
      remember?: Array<Record<string, unknown>>;
    };
    result: void;
  };
  /**
   * Pages BACKWARDS from `beforeSeq` — the transcript is read from the bottom.
   * Reaches past the ring buffer into the persisted history on disk, which is
   * what makes the buffer a replay window rather than the archive.
   */
  'history.get': {
    params: { sessionId: string; beforeSeq?: number; limit: number };
    result: { events: SessionScopedPush[]; hasMore: boolean };
  };
  'rpc.invoke': { params: { channel: string; params?: Record<string, unknown> }; result: unknown };
}

export type ParamsOf<M extends ClientMethod> = M extends keyof ProtocolRequestMap
  ? ProtocolRequestMap[M]['params']
  : never;

export type ResultOf<M extends ClientMethod> = M extends keyof ProtocolRequestMap
  ? ProtocolRequestMap[M]['result']
  : never;

/**
 * The client half.
 *
 * `request` is the only way to talk: correlating `requestId` and rejecting on
 * an `ok: false` response is the transport's job, so call sites see a plain
 * promise and a typed result rather than a message pump.
 */
export interface ProtocolClient {
  readonly state: ConnectionState;

  /** Resolves once `hello` has been answered with `welcome`. */
  connect(): Promise<ProtocolRequestMap['hello']['result']>;
  disconnect(): void;

  request<M extends ClientMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;

  /** Every server push except `response` (which `request` consumes). */
  onPush(listener: (message: ServerMessage) => void): Unsubscribe;
  onStateChange(listener: (state: ConnectionState) => void): Unsubscribe;
}

/**
 * Per-connection state a handler needs.
 *
 * Subscription is per client, not per session: the daemon fans one session out
 * to every subscriber, which is the whole point of being able to pick a
 * session up on the iPad that was started on the laptop.
 */
export interface ClientContext {
  readonly clientId: string;
  readonly clientKind: 'electron' | 'web';
  readonly subscriptions: ReadonlySet<string>;
  subscribe(sessionId: string): void;
  unsubscribe(sessionId: string): void;
  /** Push to this one client, outside any request/response pair. */
  send(message: ServerMessage): void;
}

/**
 * One handler per method. Throwing a `ProtocolError`-shaped object becomes an
 * `ok: false` response; anything else becomes `INTERNAL` — a daemon must not
 * leak a stack trace to a client, nor die because a handler rejected.
 */
export type ProtocolHandlers = {
  [M in ClientMethod]: (params: ParamsOf<M>, ctx: ClientContext) => Promise<ResultOf<M>> | ResultOf<M>;
};

export interface ProtocolServer {
  register(handlers: ProtocolHandlers): void;

  /** Deliver to every client subscribed to that session, in seq order. */
  pushToSession(sessionId: string, message: SessionScopedPush): void;

  /** Deliver to every connected client: list deltas and legacy app-wide channels. */
  broadcast(message: Extract<ServerMessage, { type: 'project.changed' | 'session.changed' | 'channel' }>): void;

  readonly clients: readonly ClientContext[];
}

/** Narrow an unknown throw to a protocol error without trusting its shape. */
export function isProtocolError(err: unknown): err is ProtocolError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { message?: unknown }).message === 'string'
  );
}

/** Re-exported so a transport can type its inbound frames in one import. */
export type { ClientMessage, ServerMessage };
