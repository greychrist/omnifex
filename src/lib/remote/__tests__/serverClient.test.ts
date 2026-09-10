import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createServerClient, RemoteClientError, type WebSocketLike } from '@/lib/remote/serverClient';
import { PROTOCOL_VERSION } from '@/protocol';

/** A scripted socket: the test plays the daemon. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }
  // --- daemon side ---
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(m: unknown): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  /** Answer the most recent request of a type. */
  answer(type: string, result: unknown): void {
    const req = [...this.sent].reverse().find((s) => s.type === type);
    if (!req) throw new Error(`no ${type} request was sent`);
    this.receive({ type: 'response', requestId: req.requestId, ok: true, result });
  }
  fail(type: string, code: string, message: string): void {
    const req = [...this.sent].reverse().find((s) => s.type === type);
    if (!req) throw new Error(`no ${type} request was sent`);
    this.receive({ type: 'response', requestId: req.requestId, ok: false, error: { code, message } });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
}

const WELCOME = { protocolVersion: PROTOCOL_VERSION, daemonVersion: 't', capabilities: {} };

function make(overrides: Partial<Parameters<typeof createServerClient>[0]> = {}) {
  return createServerClient({
    url: 'ws://daemon/ws',
    clientId: 'c1',
    clientKind: 'electron',
    createSocket: (url) => new FakeSocket(url),
    reconnect: { initialMs: 100, maxMs: 400 },
    requestTimeoutMs: 5000,
    ...overrides,
  });
}

/** Connect and complete the handshake. */
async function connected(client = make()) {
  const p = client.connect();
  const sock = FakeSocket.instances.at(-1)!;
  sock.open();
  sock.answer('hello', WELCOME);
  await p;
  return { client, sock };
}

describe('server client', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends hello first, resolves connect on the response, and exposes welcome', async () => {
    const client = make();
    const states: string[] = [];
    client.onStateChange((s) => states.push(s));
    const p = client.connect();
    const sock = FakeSocket.instances[0];
    expect(sock.url).toBe('ws://daemon/ws');
    sock.open();
    expect(sock.sent[0]).toMatchObject({ type: 'hello', clientId: 'c1', clientKind: 'electron', protocolVersion: PROTOCOL_VERSION });
    sock.receive({ type: 'welcome', ...WELCOME });
    sock.answer('hello', WELCOME);
    expect(await p).toEqual(WELCOME);
    expect(client.state).toBe('connected');
    expect(client.welcome).toEqual(WELCOME);
    expect(states).toEqual(['connecting', 'connected']);
  });

  it('correlates responses by requestId and rejects ok:false with the code', async () => {
    const { client, sock } = await connected();
    const a = client.request('session.list', {});
    const b = client.request('project.list', {});
    sock.answer('project.list', [{ projectId: 'p' }]);
    sock.fail('session.list', 'NOT_FOUND', 'nope');
    await expect(b).resolves.toEqual([{ projectId: 'p' }]);
    await expect(a).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'nope' });
  });

  it('delivers pushes to onPush listeners and never responses', async () => {
    const { client, sock } = await connected();
    const seen: string[] = [];
    client.onPush((m) => seen.push(m.type));
    sock.receive({ type: 'event', sessionId: 's', seq: 1, kind: 'transcript', payload: {} });
    sock.receive({ type: 'channel', channel: 'x', payload: null });
    sock.receive({ type: 'response', requestId: 'stray', ok: true, result: 1 });
    expect(seen).toEqual(['event', 'channel']);
  });

  it('drops frames that are not protocol messages without dying', async () => {
    const { client, sock } = await connected();
    const seen: string[] = [];
    client.onPush((m) => seen.push(m.type));
    sock.onmessage?.({ data: 'garbage' });
    sock.receive({ type: 'nonsense' });
    sock.receive({ type: 'channel', channel: 'x', payload: null });
    expect(seen).toEqual(['channel']);
  });

  it('reconnects with backoff after a drop, re-hellos, and flushes requests queued meanwhile', async () => {
    const { client, sock } = await connected();
    const states: string[] = [];
    client.onStateChange((s) => states.push(s));

    sock.drop();
    expect(client.state).toBe('reconnecting');
    // A request while down is queued, not rejected.
    const queued = client.request('project.list', {});

    vi.advanceTimersByTime(100);
    const sock2 = FakeSocket.instances[1];
    expect(sock2).toBeDefined();
    sock2.open();
    expect(sock2.sent.map((s) => s.type)).toEqual(['hello']);
    sock2.answer('hello', WELCOME);
    // The greeting resolves on a microtask; only after it does the queue
    // flush, and it goes out in order.
    await vi.advanceTimersByTimeAsync(0);
    expect(sock2.sent.map((s) => s.type)).toEqual(['hello', 'project.list']);
    sock2.answer('project.list', []);
    await expect(queued).resolves.toEqual([]);
    expect(states).toEqual(['reconnecting', 'connected']);
  });

  it('backs off exponentially up to the cap, then resets after a successful connect', async () => {
    const { sock } = await connected();
    sock.drop();
    vi.advanceTimersByTime(100); // attempt 2 opens
    FakeSocket.instances[1].drop();
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(199);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1); // 200ms
    expect(FakeSocket.instances).toHaveLength(3);
    FakeSocket.instances[2].drop();
    vi.advanceTimersByTime(400); // capped at 400
    expect(FakeSocket.instances).toHaveLength(4);
    FakeSocket.instances[3].open();
    FakeSocket.instances[3].answer('hello', WELCOME);
    await vi.advanceTimersByTimeAsync(0); // let the greeting land and reset the backoff
    FakeSocket.instances[3].drop();
    vi.advanceTimersByTime(100); // back to the initial delay
    expect(FakeSocket.instances).toHaveLength(5);
  });

  it('fails in-flight requests on a drop rather than leaving them hanging', async () => {
    const { client, sock } = await connected();
    const inflight = client.request('session.list', {});
    sock.drop();
    await expect(inflight).rejects.toBeInstanceOf(RemoteClientError);
    await expect(inflight).rejects.toMatchObject({ code: 'DISCONNECTED' });
  });

  it('gives up on a protocol version mismatch instead of reconnecting forever', async () => {
    const client = make();
    const p = client.connect();
    const sock = FakeSocket.instances[0];
    sock.open();
    sock.fail('hello', 'PROTOCOL_VERSION_MISMATCH', 'daemon speaks 2');
    await expect(p).rejects.toMatchObject({ code: 'PROTOCOL_VERSION_MISMATCH' });
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(client.state).toBe('disconnected');
  });

  it('disconnect() stops reconnecting and rejects everything outstanding', async () => {
    const { client, sock } = await connected();
    const req = client.request('project.list', {});
    client.disconnect();
    expect(sock.closed?.code).toBe(1000);
    await expect(req).rejects.toMatchObject({ code: 'DISCONNECTED' });
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(client.state).toBe('disconnected');
    await expect(client.request('project.list', {})).rejects.toMatchObject({ code: 'DISCONNECTED' });
  });

  it('times out a request the daemon never answers', async () => {
    const { client } = await connected(make({ requestTimeoutMs: 1000 }));
    const req = client.request('project.list', {});
    vi.advanceTimersByTime(1000);
    await expect(req).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
