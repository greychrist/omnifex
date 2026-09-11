// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { installRemoteBridge } from '@/lib/remote/bootstrap';
import type { WebSocketLike } from '@/lib/remote/serverClient';
import { PROTOCOL_VERSION } from '@/protocol';
import type { NativeBridge } from '@/lib/platform';

/**
 * The preload bridge publishes ONLY `__omnifexNative`. `contextBridge` defines
 * its properties ReadOnly | DontDelete, so anything it put at
 * `window.electronAPI` could never be replaced by the shim — the assignment
 * threw, the try/catch read it as a handshake failure, and every Electron
 * launch silently fell back to legacy IPC (2026-09-10). `electronAPI` is
 * therefore bootstrap's to define, in every mode.
 */

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
const WELCOME = { protocolVersion: PROTOCOL_VERSION, daemonVersion: 't', capabilities: {} };

function nativeBridge(remoteUrl: string | null): NativeBridge {
  return {
    invoke: vi.fn(async (channel: string) => (channel === 'remote:url' ? remoteUrl : null)),
    onEvent: vi.fn(() => () => {}),
  } as unknown as NativeBridge;
}

/** Let the client's `onopen` → hello → response chain settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('installRemoteBridge (Electron)', () => {
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
  });

  it('installs the shim as window.electronAPI once the daemon answers hello', async () => {
    const native = nativeBridge(URL);
    w.__omnifexNative = native;

    const p = installRemoteBridge({ createSocket: (url) => new FakeSocket(url) });
    await tick();
    const sock = FakeSocket.instances.at(-1)!;
    expect(sock.url).toBe(URL);
    sock.open();
    sock.reply('hello', { ok: true, result: WELCOME });
    const info = await p;

    expect(info.mode).toBe('electron-remote');
    expect(w.electronAPI).toBeDefined();
    expect(w.electronAPI).not.toBe(native);
    expect(typeof (w.electronAPI as { invoke: unknown }).invoke).toBe('function');
    expect(w.__omnifexNative).toBe(native);
  });

  /**
   * "Work locally" is a flag plus a reload — there is no way to swap the
   * transport in place — so bootstrap has to honour the flag on the way back
   * up, before it probes anything. Probing anyway would start a daemon the
   * user just chose to step away from.
   */
  it('skips the daemon entirely when local mode has been forced', async () => {
    sessionStorage.setItem('omnifex.remote.forceLocal', '1');
    const native = nativeBridge(URL);
    w.__omnifexNative = native;

    const info = await installRemoteBridge({ createSocket: (url) => new FakeSocket(url) });

    expect(info.mode).toBe('electron-legacy');
    expect(info.forcedLocal).toBe(true);
    expect(w.electronAPI).toBe(native);
    // Neither probed nor dialled: `remote:url` starts a daemon when none is
    // running, which is the opposite of what the user asked for.
    expect(native.invoke).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(0);
    sessionStorage.clear();
  });

  it('reports forcedLocal false for an ordinary legacy launch', async () => {
    w.__omnifexNative = nativeBridge(null);
    const info = await installRemoteBridge({ createSocket: (url) => new FakeSocket(url) });
    expect(info.mode).toBe('electron-legacy');
    expect(info.forcedLocal).toBe(false);
  });

  it('legacy: with no daemon, window.electronAPI is the native bridge itself', async () => {
    const native = nativeBridge(null);
    w.__omnifexNative = native;

    const info = await installRemoteBridge({ createSocket: () => { throw new Error('no socket expected'); } });

    expect(info.mode).toBe('electron-legacy');
    expect(w.electronAPI).toBe(native);
  });

  it('a failed handshake leaves the native bridge in place', async () => {
    const native = nativeBridge(URL);
    w.__omnifexNative = native;

    const p = installRemoteBridge({ createSocket: (url) => new FakeSocket(url) });
    await tick();
    const sock = FakeSocket.instances.at(-1)!;
    sock.open();
    sock.reply('hello', { ok: false, error: { code: 'PROTOCOL_VERSION_MISMATCH', message: 'nope' } });
    const info = await p;

    expect(info.mode).toBe('electron-legacy');
    expect(w.electronAPI).toBe(native);
  });

  it('the native bridge is in place before the daemon is even probed', async () => {
    const native = nativeBridge(null);
    let seenDuringProbe: unknown = 'unset';
    (native.invoke as ReturnType<typeof vi.fn>).mockImplementation(async (channel: string) => {
      if (channel === 'remote:url') seenDuringProbe = w.electronAPI;
      return null;
    });
    w.__omnifexNative = native;

    await installRemoteBridge();

    expect(seenDuringProbe).toBe(native);
  });
});
