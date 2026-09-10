/**
 * `ProtocolServer` over WebSocket, plus the handful of HTTP routes a person
 * with `curl` needs to trust the thing is up.
 *
 * Transport concerns live here and nowhere else: framing, the `hello`
 * handshake, request/response correlation, per-client subscriptions, fan-out,
 * dead-peer detection, static files. What a method *does* is a handler's
 * business (`handlers.ts`); what a message *is* is the protocol's
 * (`src/protocol`).
 *
 * There is no authentication. The bind address is the boundary — see
 * `config.ts` for why it is never `0.0.0.0` by default.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  PROTOCOL_VERSION,
  decodeClientMessage,
  type ClientMessage,
  type ClientMethod,
  type ProtocolError,
  type ServerMessage,
  type SessionScopedPush,
} from '../../src/protocol';
import {
  isProtocolError,
  type ClientContext,
  type ParamsOf,
  type ProtocolHandlers,
  type ProtocolServer,
} from '../../src/protocol/interfaces';

export interface RemoteServerLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface RemoteServerDeps {
  host: string;
  port: number;
  daemonVersion: string;
  capabilities?: Record<string, unknown>;
  /** Directory of static files served at `/` (the web client). Null = none. */
  webRoot?: string | null;
  /** JSON bodies for the curl-level routes. */
  api: {
    health(): unknown;
    sessions(): unknown;
    projects(): unknown;
    /** Web Push (Phase 6). Absent → the routes 404. */
    push?: {
      publicKey(): string;
      subscribe(body: unknown): unknown;
      unsubscribe(body: unknown): unknown;
    };
  };
  log?: RemoteServerLogger;
  /** Dead-peer ping interval. Tests shorten it; 0 disables. */
  heartbeatMs?: number;
}

export interface RemoteServer extends ProtocolServer {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  readonly address: { host: string; port: number } | null;
  /** How many clients are subscribed to a session right now. */
  subscriberCount(sessionId: string): number;
}

const NOOP_LOG: RemoteServerLogger = { debug() {}, info() {}, warn() {}, error() {} };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

interface Connection extends ClientContext {
  socket: WebSocket;
  alive: boolean;
  /** Set once `hello` has been accepted; requests before it are refused. */
  greeted: boolean;
  clientId: string;
  clientKind: 'electron' | 'web';
  subscriptions: Set<string>;
}

export function createRemoteServer(deps: RemoteServerDeps): RemoteServer {
  const log = deps.log ?? NOOP_LOG;
  const heartbeatMs = deps.heartbeatMs ?? 30_000;

  let handlers: ProtocolHandlers | null = null;
  const connections = new Set<Connection>();
  const subscribers = new Map<string, Set<Connection>>();
  let http: Server | null = null;
  let wss: WebSocketServer | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let address: { host: string; port: number } | null = null;

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  function send(conn: Connection, message: ServerMessage): void {
    if (conn.socket.readyState !== conn.socket.OPEN) return;
    const frame = JSON.stringify(message);
    log.debug('→', { clientId: conn.clientId, type: message.type });
    conn.socket.send(frame);
  }

  function respondOk(conn: Connection, requestId: string, result: unknown): void {
    send(conn, { type: 'response', requestId, ok: true, result });
  }

  function respondError(conn: Connection, requestId: string, error: ProtocolError): void {
    send(conn, { type: 'response', requestId, ok: false, error });
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  function subscribe(conn: Connection, sessionId: string): void {
    conn.subscriptions.add(sessionId);
    let set = subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      subscribers.set(sessionId, set);
    }
    set.add(conn);
  }

  function unsubscribe(conn: Connection, sessionId: string): void {
    conn.subscriptions.delete(sessionId);
    const set = subscribers.get(sessionId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) subscribers.delete(sessionId);
  }

  function dropConnection(conn: Connection): void {
    for (const id of [...conn.subscriptions]) unsubscribe(conn, id);
    connections.delete(conn);
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  async function dispatch(conn: Connection, message: ClientMessage): Promise<void> {
    if (message.type === 'hello') {
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        respondError(conn, message.requestId, {
          code: 'PROTOCOL_VERSION_MISMATCH',
          message: `daemon speaks protocol ${PROTOCOL_VERSION}, client sent ${message.protocolVersion}`,
        });
        // A mismatched peer quietly misreading pushes is worse than no peer.
        conn.socket.close(1002, 'protocol version mismatch');
        return;
      }
      conn.greeted = true;
      conn.clientId = message.clientId;
      conn.clientKind = message.clientKind;
      const welcome = {
        protocolVersion: PROTOCOL_VERSION,
        daemonVersion: deps.daemonVersion,
        capabilities: deps.capabilities ?? {},
      };
      send(conn, { type: 'welcome', ...welcome });
      respondOk(conn, message.requestId, welcome);
      log.info('client connected', { clientId: conn.clientId, clientKind: conn.clientKind });
      return;
    }

    if (!conn.greeted) {
      respondError(conn, message.requestId, { code: 'MALFORMED_MESSAGE', message: 'send hello first' });
      return;
    }
    if (!handlers) {
      respondError(conn, message.requestId, { code: 'INTERNAL', message: 'daemon has no handlers registered' });
      return;
    }

    const { type, requestId, ...params } = message;
    const handler = handlers[type as ClientMethod] as
      | ((p: ParamsOf<ClientMethod>, ctx: ClientContext) => unknown)
      | undefined;
    if (!handler) {
      respondError(conn, requestId, { code: 'MALFORMED_MESSAGE', message: `unknown method ${type}` });
      return;
    }

    try {
      const result = await handler(params as ParamsOf<ClientMethod>, conn);
      respondOk(conn, requestId, result ?? null);
    } catch (err) {
      if (isProtocolError(err)) {
        respondError(conn, requestId, { code: err.code, message: err.message });
      } else {
        // Never a stack trace to a client; the full error goes to the log.
        log.error(`handler ${type} failed`, { error: err instanceof Error ? err.stack ?? err.message : String(err) });
        respondError(conn, requestId, { code: 'INTERNAL', message: `${type} failed` });
      }
    }
  }

  function onSocket(socket: WebSocket): void {
    const conn: Connection = {
      socket,
      alive: true,
      greeted: false,
      clientId: 'anonymous',
      clientKind: 'web',
      subscriptions: new Set(),
      subscribe: (id) => subscribe(conn, id),
      unsubscribe: (id) => unsubscribe(conn, id),
      send: (m) => send(conn, m),
    };
    connections.add(conn);

    socket.on('pong', () => { conn.alive = true; });
    socket.on('close', () => {
      dropConnection(conn);
      log.info('client disconnected', { clientId: conn.clientId });
    });
    socket.on('error', (err) => {
      log.warn('socket error', { clientId: conn.clientId, error: err.message });
    });
    socket.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
      } catch {
        send(conn, { type: 'error', code: 'MALFORMED_MESSAGE', message: 'frame is not JSON' });
        return;
      }
      const decoded = decodeClientMessage(raw);
      if (!decoded.ok) {
        const requestId = (raw as { requestId?: unknown } | null)?.requestId;
        send(conn, {
          type: 'error',
          ...(typeof requestId === 'string' && { requestId }),
          code: decoded.error.code,
          message: decoded.error.message,
        });
        return;
      }
      log.debug('←', { clientId: conn.clientId, type: decoded.message.type });
      void dispatch(conn, decoded.message);
    });
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  function json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    res.end(text);
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): boolean {
    const root = deps.webRoot;
    if (!root) return false;
    const rootAbs = resolve(root);
    // Resolve inside the root and refuse anything that escapes it. Decoding
    // first so `%2e%2e` cannot slip past the `..` check.
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return false;
    }
    const target = normalize(join(rootAbs, decoded));
    if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return false;

    let file = target;
    let st = existsSync(file) ? statSync(file) : null;
    if (st?.isDirectory()) {
      file = join(file, 'index.html');
      st = existsSync(file) ? statSync(file) : null;
    }
    if (!st?.isFile()) {
      // SPA fallback: a deep link into the client renders index.html and lets
      // the client router take it from there. Asset-looking paths 404.
      if (extname(decoded)) return false;
      file = join(rootAbs, 'index.html');
      if (!existsSync(file)) return false;
      st = statSync(file);
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': st.size,
      // The service worker and manifest must be re-fetched freely.
      'cache-control': extname(file) === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(file).pipe(res);
    return true;
  }

  function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
    return new Promise((resolvePromise, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolvePromise(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // The only writes: push subscription management, JSON in, JSON out.
    if (req.method === 'POST' && url.pathname.startsWith('/api/push/')) {
      const push = deps.api.push;
      if (!push) {
        json(res, 404, { error: 'push not enabled' });
        return;
      }
      readJsonBody(req)
        .then((body) => {
          if (url.pathname === '/api/push/subscribe') json(res, 200, push.subscribe(body));
          else if (url.pathname === '/api/push/unsubscribe') json(res, 200, push.unsubscribe(body));
          else json(res, 404, { error: 'not found' });
        })
        .catch((err: unknown) => {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    if (url.pathname === '/api/push/vapid-public-key') {
      const push = deps.api.push;
      if (!push) json(res, 404, { error: 'push not enabled' });
      else json(res, 200, { publicKey: push.publicKey() });
      return;
    }
    switch (url.pathname) {
      case '/healthz':
        json(res, 200, deps.api.health());
        return;
      case '/api/sessions':
        json(res, 200, deps.api.sessions());
        return;
      case '/api/projects':
        json(res, 200, deps.api.projects());
        return;
      default:
        if (serveStatic(req, res, url.pathname)) return;
        json(res, 404, { error: 'not found' });
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  return {
    get clients() {
      return [...connections];
    },
    get address() {
      return address;
    },
    subscriberCount(sessionId) {
      return subscribers.get(sessionId)?.size ?? 0;
    },

    register(h) {
      handlers = h;
    },

    pushToSession(sessionId, message: SessionScopedPush) {
      const set = subscribers.get(sessionId);
      if (!set) return;
      for (const conn of set) send(conn, message);
    },

    broadcast(message) {
      for (const conn of connections) if (conn.greeted) send(conn, message);
    },

    listen() {
      return new Promise((resolvePromise, reject) => {
        http = createServer(onRequest);
        wss = new WebSocketServer({ server: http, path: '/ws' });
        wss.on('connection', onSocket);
        if (heartbeatMs > 0) {
          heartbeat = setInterval(() => {
            for (const conn of connections) {
              if (!conn.alive) {
                log.info('terminating unresponsive client', { clientId: conn.clientId });
                conn.socket.terminate();
                continue;
              }
              conn.alive = false;
              conn.socket.ping();
            }
          }, heartbeatMs);
        }
        http.once('error', reject);
        http.listen(deps.port, deps.host, () => {
          const a = http!.address();
          address =
            typeof a === 'object' && a
              ? { host: a.address, port: a.port }
              : { host: deps.host, port: deps.port };
          log.info('listening', { ...address, ws: '/ws' });
          resolvePromise(address);
        });
      });
    },

    close() {
      return new Promise((resolvePromise) => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        for (const conn of connections) conn.socket.close(1001, 'daemon shutting down');
        connections.clear();
        subscribers.clear();
        const finish = () => {
          address = null;
          resolvePromise();
        };
        if (!http) {
          finish();
          return;
        }
        wss?.close();
        http.close(() => finish());
        http = null;
        wss = null;
      });
    },
  };
}
