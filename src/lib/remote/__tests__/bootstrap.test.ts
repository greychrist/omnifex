// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { installRemoteBridge } from '@/lib/remote/bootstrap';
import type { WebSocketLike } from '@/lib/remote/serverClient';
import type { NativeBridge } from '@/lib/platform';

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  reply(type: string, body: Record<string, unknown>): void {
    const req = [...this.sent].reverse().find((s) => s.type === type);
    if (!req) throw new Error(`no ${type} request was sent`);
    this.onmessage?.({ data: JSON.stringify({ type: 'response', requestId: req.requestId, ...body }) });
  }
}

const URL = 'ws://100.64.0.1:47700/ws';

function nativeBridge(remoteUrl: string | null): NativeBridge {
  return {
    invoke: vi.fn(async (channel: string) => (channel === 'remote:url' ? remoteUrl : null)),
    onEvent: vi.fn(() => () => {}),
  };
}

/** Let the client's `onopen` → hello → response chain settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('installRemoteBridge (desktop)', () => {
  const w = window as unknown as { electronAPI?: unknown; __omnifexNative?: NativeBridge; __omnifexRemote?: unknown };

  beforeEach(() => {
    FakeSocket.instances = [];
    delete w.electronAPI;
    delete w.__omnifexNative;
    delete w.__omnifexRemote;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    delete (globalThis as unknown as { ClipboardItem?: unknown }).ClipboardItem;
  });

  it('installs the shim over the daemon the app reports, keeping the native bridge for native channels', async () => {
    const native = nativeBridge(URL);
    w.__omnifexNative = native;

    const info = await installRemoteBridge({ createSocket: (url) => new FakeSocket(url) });

    expect(info.mode).toBe('desktop');
    expect(info.url).toBe(URL);
    expect(w.electronAPI).toBeDefined();
    expect(w.electronAPI).not.toBe(native);
    expect(typeof (w.electronAPI as { invoke: unknown }).invoke).toBe('function');
    expect(w.__omnifexNative).toBe(native);
    await tick();
    expect(FakeSocket.instances.at(-1)!.url).toBe(URL);
  });

  // Plain http on the tailnet address is no secure context in WebKit, so the
  // async clipboard is missing.
  it('gives the page the native clipboard', async () => {
    const native = nativeBridge(URL);
    w.__omnifexNative = native;
    await installRemoteBridge({ createSocket: (url) => new FakeSocket(url) });
    await navigator.clipboard.writeText('copied');
    expect(native.invoke).toHaveBeenCalledWith('clipboard:write', { items: [{ type: 'text/plain', text: 'copied' }] });
  });

  it('does not wait for the handshake before installing', async () => {
    w.__omnifexNative = nativeBridge(URL);
    const info = await installRemoteBridge({ createSocket: (url) => new FakeSocket(url) });
    expect(info.client).not.toBeNull();
    expect(info.client!.state).not.toBe('connected');
  });

  it('dials the page origin when the app has no daemon url', async () => {
    w.__omnifexNative = nativeBridge(null);
    const info = await installRemoteBridge({ createSocket: (url) => new FakeSocket(url) });
    const expected = `ws://${location.host}/ws`;
    expect(info.mode).toBe('desktop');
    expect(info.url).toBe(expected);
    await tick();
    expect(FakeSocket.instances.at(-1)!.url).toBe(expected);
  });

  it('dials the page origin when asking the app throws', async () => {
    const native = nativeBridge(URL);
    (native.invoke as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('bridge down'));
    w.__omnifexNative = native;
    const info = await installRemoteBridge({ createSocket: (url) => new FakeSocket(url) });
    expect(info.url).toBe(`ws://${location.host}/ws`);
  });
});
