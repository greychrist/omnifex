import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import WebSocket from 'ws';

import { createRemoteServer, type RemoteServer } from '../remote/server';
import { PROTOCOL_VERSION, type ServerMessage } from '../../src/protocol';
import type { ProtocolHandlers } from '../../src/protocol/interfaces';

/** A thin scripted client: collects every frame, resolves responses by id. */
class TestClient {
  private ws: WebSocket;
  readonly frames: ServerMessage[] = [];
  private waiters: Array<(m: ServerMessage) => void> = [];
  private n = 0;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      this.frames.push(m);
      for (const w of this.waiters.splice(0)) w(m);
    });
  }

  open(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
  }

  closed(): Promise<{ code: number }> {
    return new Promise((res) => this.ws.once('close', (code) => res({ code })));
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  /** Send a request and resolve with its response frame. */
  async request(type: string, params: Record<string, unknown> = {}): Promise<ServerMessage> {
    const requestId = `r${++this.n}`;
    const p = this.next((m) => m.type === 'response' && m.requestId === requestId);
    this.ws.send(JSON.stringify({ type, requestId, ...params }));
    return p;
  }

  next(pred: (m: ServerMessage) => boolean): Promise<ServerMessage> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res) => {
      const w = (m: ServerMessage) => { if (pred(m)) res(m); else this.waiters.push(w); };
      this.waiters.push(w);
    });
  }

  hello(kind: 'electron' | 'web' = 'web', version = PROTOCOL_VERSION) {
    return this.request('hello', { clientId: `c-${kind}`, clientKind: kind, protocolVersion: version });
  }

  close(): void {
    this.ws.close();
  }
}

const handlers = (overrides: Partial<ProtocolHandlers> = {}): ProtocolHandlers => ({
  hello: () => ({ protocolVersion: PROTOCOL_VERSION, daemonVersion: 't' }),
  'project.list': () => [],
  'project.add': () => ({ projectId: 'p', path: '/p' }),
  'project.remove': () => undefined,
  'session.list': () => [],
  'session.create': () => { throw new Error('boom: secret path /Users/greg'); },
  'session.resume': () => { throw { code: 'NOT_FOUND', message: 'no such session' }; },
  'session.kill': () => undefined,
  'session.subscribe': (p, ctx) => { ctx.subscribe(p.sessionId); return { fromSeq: p.fromSeq ?? 0, lastSeq: 0 }; },
  'session.unsubscribe': (p, ctx) => { ctx.unsubscribe(p.sessionId); },
  'turn.send': () => undefined,
  'turn.interrupt': () => undefined,
  'permission.respond': () => undefined,
  'history.get': () => ({ events: [], hasMore: false }),
  'rpc.invoke': (p) => ({ echoed: p.channel }),
  ...overrides,
});

describe('remote server', () => {
  let server: RemoteServer;
  let url: string;
  let base: string;
  let webRoot: string;

  beforeEach(async () => {
    webRoot = mkdtempSync(join(tmpdir(), 'omnifex-webroot-'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>OmniFex</title>');
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log(1)');
    server = createRemoteServer({
      host: '127.0.0.1',
      port: 0,
      daemonVersion: '0.0.0-test',
      capabilities: { tui: false },
      webRoot,
      heartbeatMs: 0,
      api: {
        health: () => ({ ok: true }),
        sessions: () => [{ sessionId: 's1' }],
        projects: () => [{ projectId: 'p1' }],
      },
    });
    server.register(handlers());
    const a = await server.listen();
    url = `ws://${a.host}:${a.port}/ws`;
    base = `http://${a.host}:${a.port}`;
  });

  afterEach(async () => {
    await server.close();
    rmSync(webRoot, { recursive: true, force: true });
  });

  it('answers hello with welcome and a response, and counts the client', async () => {
    const c = new TestClient(url);
    await c.open();
    const res = await c.hello('electron');
    expect(res).toMatchObject({ ok: true, result: { protocolVersion: PROTOCOL_VERSION, daemonVersion: '0.0.0-test' } });
    expect(c.frames.map((f) => f.type)).toEqual(['welcome', 'response']);
    expect(server.clients.map((x) => x.clientKind)).toEqual(['electron']);
    c.close();
  });

  it('refuses a protocol version it does not speak and closes', async () => {
    const c = new TestClient(url);
    await c.open();
    const closed = c.closed();
    const res = await c.hello('web', 99);
    expect(res).toMatchObject({ ok: false, error: { code: 'PROTOCOL_VERSION_MISMATCH' } });
    expect((await closed).code).toBe(1002);
  });

  it('refuses requests before hello', async () => {
    const c = new TestClient(url);
    await c.open();
    const res = await c.request('session.list');
    expect(res).toMatchObject({ ok: false, error: { code: 'MALFORMED_MESSAGE' } });
    c.close();
  });

  it('dispatches to the handler and echoes the requestId', async () => {
    const c = new TestClient(url);
    await c.open();
    await c.hello();
    const res = await c.request('rpc.invoke', { channel: 'list_accounts' });
    expect(res).toMatchObject({ ok: true, result: { echoed: 'list_accounts' } });
    c.close();
  });

  it('turns a protocol-shaped throw into its code and everything else into INTERNAL without the message', async () => {
    const c = new TestClient(url);
    await c.open();
    await c.hello();
    expect(await c.request('session.resume', { sessionId: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'no such session' },
    });
    const internal = await c.request('session.create', { projectId: 'p' });
    expect(internal).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(internal)).not.toContain('/Users/greg');
    c.close();
  });

  it('answers a non-JSON frame and a malformed message with an error push, not a dropped socket', async () => {
    const c = new TestClient(url);
    await c.open();
    await c.hello();
    c.sendRaw('not json');
    const e1 = await c.next((m) => m.type === 'error');
    expect(e1).toMatchObject({ code: 'MALFORMED_MESSAGE' });
    c.sendRaw(JSON.stringify({ type: 'session.explode', requestId: 'r-x' }));
    const e2 = await c.next((m) => m.type === 'error' && (m as { requestId?: string }).requestId === 'r-x');
    expect(e2).toMatchObject({ code: 'MALFORMED_MESSAGE', requestId: 'r-x' });
    const still = await c.request('project.list');
    expect(still).toMatchObject({ ok: true });
    c.close();
  });

  it('fans a session push out to subscribers only, and a broadcast to every greeted client', async () => {
    const a = new TestClient(url);
    const b = new TestClient(url);
    const lurker = new TestClient(url);
    await Promise.all([a.open(), b.open(), lurker.open()]);
    await a.hello('electron');
    await b.hello('web');
    // lurker never says hello.

    await a.request('session.subscribe', { sessionId: 's1', fromSeq: 0 });

    server.pushToSession('s1', { type: 'event', sessionId: 's1', seq: 1, kind: 'transcript', payload: {} });
    server.pushToSession('s2', { type: 'event', sessionId: 's2', seq: 1, kind: 'transcript', payload: {} });
    server.broadcast({ type: 'channel', channel: 'rate-limits:updated', payload: null });

    await a.next((m) => m.type === 'channel');
    await b.next((m) => m.type === 'channel');
    await new Promise((r) => setTimeout(r, 20));

    expect(a.frames.filter((m) => m.type === 'event').map((m) => (m as { sessionId: string }).sessionId)).toEqual(['s1']);
    expect(b.frames.filter((m) => m.type === 'event')).toEqual([]);
    expect(b.frames.some((m) => m.type === 'channel')).toBe(true);
    expect(lurker.frames).toEqual([]);

    await a.request('session.unsubscribe', { sessionId: 's1' });
    server.pushToSession('s1', { type: 'event', sessionId: 's1', seq: 2, kind: 'transcript', payload: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(a.frames.filter((m) => m.type === 'event')).toHaveLength(1);

    a.close(); b.close(); lurker.close();
  });

  it('drops a client\'s subscriptions when its socket closes', async () => {
    const a = new TestClient(url);
    await a.open();
    await a.hello();
    await a.request('session.subscribe', { sessionId: 's1' });
    const closed = a.closed();
    a.close();
    await closed;
    await new Promise((r) => setTimeout(r, 20));
    expect(server.clients).toHaveLength(0);
    // Pushing to a session with no subscribers is a no-op, not a throw.
    expect(() => server.pushToSession('s1', { type: 'event', sessionId: 's1', seq: 3, kind: 'transcript', payload: {} })).not.toThrow();
  });

  describe('http', () => {
    const fetchText = (path: string, method = 'GET') =>
      new Promise<{ status: number; body: string; type: string | undefined; cors: string | undefined }>((res, rej) => {
        const req = httpGet(`${base}${path}`, { method }, (r) => {
          let body = '';
          r.on('data', (d) => { body += d; });
          r.on('end', () => res({
            status: r.statusCode ?? 0,
            body,
            type: r.headers['content-type'],
            cors: r.headers['access-control-allow-origin'],
          }));
        });
        req.on('error', rej);
      });

    it('serves /healthz, /api/sessions and /api/projects as JSON, readable cross-origin', async () => {
      const health = await fetchText('/healthz');
      expect(JSON.parse(health.body)).toEqual({ ok: true });
      // The Electron renderer's title-bar Daemon panel reads this from
      // localhost (dev) or its own scheme (packaged).
      expect(health.cors).toBe('*');
      expect(JSON.parse((await fetchText('/api/sessions')).body)).toEqual([{ sessionId: 's1' }]);
      expect(JSON.parse((await fetchText('/api/projects')).body)).toEqual([{ projectId: 'p1' }]);
    });

    it('serves the web root with an SPA fallback and refuses to escape it', async () => {
      expect((await fetchText('/')).body).toContain('OmniFex');
      expect((await fetchText('/assets/app.js')).type).toContain('text/javascript');
      // A deep link renders the app shell…
      expect((await fetchText('/sessions/abc')).body).toContain('OmniFex');
      // …but a missing asset is a real 404, and so is a traversal.
      expect((await fetchText('/assets/nope.js')).status).toBe(404);
      expect((await fetchText('/..%2f..%2fetc/passwd')).status).toBe(404);
    });

    it('serves the push routes when a push api is wired, JSON in and out', async () => {
      const subs: unknown[] = [];
      await server.close();
      server = createRemoteServer({
        host: '127.0.0.1', port: 0, daemonVersion: 't', heartbeatMs: 0,
        api: {
          health: () => ({ ok: true }), sessions: () => [], projects: () => [],
          push: {
            publicKey: () => 'PUBKEY',
            subscribe: (b) => { subs.push(b); return { added: true }; },
            unsubscribe: () => ({ removed: true }),
          },
        },
      });
      server.register(handlers());
      const a = await server.listen();
      base = `http://${a.host}:${a.port}`;

      expect(JSON.parse((await fetchText('/api/push/vapid-public-key')).body)).toEqual({ publicKey: 'PUBKEY' });
      const post = (path: string, body: unknown) =>
        new Promise<{ status: number; body: string }>((res, rej) => {
          const req = require('node:http').request(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (r: import('node:http').IncomingMessage) => {
            let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res({ status: r.statusCode ?? 0, body: b }));
          });
          req.on('error', rej); req.end(JSON.stringify(body));
        });
      expect(JSON.parse((await post('/api/push/subscribe', { endpoint: 'https://p/1', keys: { p256dh: 'x', auth: 'y' } })).body)).toEqual({ added: true });
      expect(subs).toEqual([{ endpoint: 'https://p/1', keys: { p256dh: 'x', auth: 'y' } }]);
      expect((await post('/api/push/unsubscribe', { endpoint: 'https://p/1' })).status).toBe(200);
      expect((await post('/api/push/nope', {})).status).toBe(404);
      // Still no other writes.
      expect((await fetchText('/healthz', 'POST')).status).toBe(405);
    });

    it('404s the push routes when push is not wired', async () => {
      expect((await fetchText('/api/push/vapid-public-key')).status).toBe(404);
    });

    it('404s unknown routes and 405s writes', async () => {
      expect((await fetchText('/api/nope.json')).status).toBe(404);
      expect((await fetchText('/healthz', 'POST')).status).toBe(405);
    });
  });
});
