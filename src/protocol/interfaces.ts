import type {
  ClientKind,
  ClientMessage,
  ClientMethod,
  Project,
  ProtocolError,
  ServerMessage,
  SessionScopedPush,
  SessionSummary,
} from './messages';

export type Unsubscribe = () => void;

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** Params exclude `requestId`, which the transport mints. */
export interface ProtocolRequestMap {
  'hello': {
    params: { clientId: string; clientKind: ClientKind; protocolVersion: number };
    result: { protocolVersion: number; daemonVersion: string; bootId?: string; capabilities?: Record<string, unknown> };
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
  'session.release': { params: { sessionId: string }; result: { stopped: boolean } };
  'session.subscribe': {
    params: { sessionId: string; fromSeq?: number };
    /** `resync`: the ring could not reach back to `fromSeq`; reload the transcript from disk. */
    result: { fromSeq: number; lastSeq: number; resync?: boolean };
  };
  'session.unsubscribe': { params: { sessionId: string }; result: void };
  'turn.send': {
    params: {
      sessionId: string;
      content: string | Record<string, unknown>[];
      attachments?: { name: string; mimeType: string; dataBase64: string }[];
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
      remember?: Record<string, unknown>[];
    };
    result: void;
  };
  'rpc.invoke': { params: { channel: string; params?: Record<string, unknown> }; result: unknown };
}

export type ParamsOf<M extends ClientMethod> = M extends keyof ProtocolRequestMap
  ? ProtocolRequestMap[M]['params']
  : never;

export type ResultOf<M extends ClientMethod> = M extends keyof ProtocolRequestMap
  ? ProtocolRequestMap[M]['result']
  : never;

export interface ProtocolClient {
  readonly state: ConnectionState;

  connect(): Promise<ProtocolRequestMap['hello']['result']>;
  readonly welcome?: ProtocolRequestMap['hello']['result'] | null;
  disconnect(): void;

  request<M extends ClientMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;

  onPush(listener: (message: ServerMessage) => void): Unsubscribe;
  onStateChange(listener: (state: ConnectionState) => void): Unsubscribe;
}

export interface ClientContext {
  readonly clientId: string;
  readonly clientKind: ClientKind;
  readonly subscriptions: ReadonlySet<string>;
  subscribe(sessionId: string): void;
  unsubscribe(sessionId: string): void;
  send(message: ServerMessage): void;
  onClose(listener: () => void): void;
}

/** A thrown `ProtocolError`-shaped object becomes `ok: false`; anything else becomes `INTERNAL`, never a stack trace. */
export type ProtocolHandlers = {
  [M in ClientMethod]: (params: ParamsOf<M>, ctx: ClientContext) => Promise<ResultOf<M>> | ResultOf<M>;
};

export interface ProtocolServer {
  register(handlers: ProtocolHandlers): void;

  pushToSession(sessionId: string, message: SessionScopedPush): void;

  broadcast(message: Extract<ServerMessage, { type: 'project.changed' | 'session.changed' | 'channel' }>): void;

  readonly clients: readonly ClientContext[];
}

export function isProtocolError(err: unknown): err is ProtocolError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { message?: unknown }).message === 'string'
  );
}

export type { ClientMessage, ServerMessage };
