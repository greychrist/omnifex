// @vitest-environment node
//
// The renderer path minus React, against a REAL daemon: `window.electronAPI`
// shim → ServerClient → ws → omnifex-server → sessions service → claude CLI.
//
// Gated: runs only when OMNIFEX_DAEMON_URL is set (e.g. ws://127.0.0.1:47701/ws)
// because it needs a live daemon with an account, and it spends one tiny turn.
//
//   OMNIFEX_DAEMON_URL=ws://127.0.0.1:47701/ws npx vitest run src/lib/remote/__tests__/shim.integration.test.ts
import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';

import { createServerClient } from '@/lib/remote/serverClient';
import { createElectronApiShim } from '@/lib/remote/electronApiShim';

const URL = process.env.OMNIFEX_DAEMON_URL;
const PROJECT = process.env.OMNIFEX_DAEMON_PROJECT ?? '/tmp/omnifex-remote-probe';

const waitFor = <T>(subscribe: (cb: (v: T) => void) => () => void, pred: (v: T) => boolean, ms: number, what: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${what}`)); }, ms);
    const off = subscribe((v) => {
      if (!pred(v)) return;
      clearTimeout(timer);
      off();
      resolve(v);
    });
  });

describe.skipIf(!URL)('electronAPI shim against a live daemon', () => {
  it('starts a session, streams a turn on the legacy channels, answers a permission, stops', async () => {
    const client = createServerClient({
      url: URL!,
      clientId: 'shim-integration',
      clientKind: 'web',
      createSocket: (u) => new WebSocket(u) as unknown as import('@/lib/remote/serverClient').WebSocketLike,
      reconnect: false,
    });
    const storage = new Map<string, string>();
    const api = createElectronApiShim({
      client,
      native: null,
      storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); } },
    });
    const welcome = await client.connect();
    expect(welcome.protocolVersion).toBe(1);

    const tabId = `tab-${Date.now()}`;
    const outputs: Record<string, unknown>[] = [];
    const statuses: string[] = [];
    const onOutput = (cb: (m: Record<string, unknown>) => void) => api.onEvent(`agent-output:${tabId}`, (m) => cb(m as Record<string, unknown>));
    api.onEvent(`agent-output:${tabId}`, (m) => outputs.push(m as Record<string, unknown>));
    api.onEvent(`session-status:${tabId}`, (p) => statuses.push((p as { sessionStatus: string }).sessionStatus));

    // Exactly what useSessionLifecycle sends.
    await api.invoke('session_start', {
      tabId, projectPath: PROJECT, model: 'default', permissionMode: 'default', mode: 'rich', agent: 'claude',
    });
    expect(statuses).toEqual(['started']);
    const health = (await api.invoke('session_get_health', { tabId })) as { alive: boolean; sessionId: string | null };
    expect(health.alive).toBe(true);
    expect(health.sessionId).toBeTruthy();

    const prompt = 'Use the Write tool to create a file named shim.txt in the current directory containing exactly: shim. Then reply with one word: ok';
    const permissionOrResult = waitFor<Record<string, unknown>>(
      onOutput,
      (m) => m.type === 'permission_request' || m.type === 'result',
      150_000,
      'a permission request or a result',
    );
    await api.invoke('session_send_message', { tabId, prompt });
    let first = await permissionOrResult;
    if (first.type === 'permission_request') {
      expect(first).toMatchObject({ tool_name: 'Write' });
      const result = waitFor<Record<string, unknown>>(onOutput, (m) => m.type === 'result', 150_000, 'the result');
      await api.invoke('session_respond_permission', { tabId, behavior: 'allow' });
      first = await result;
    }
    expect(first).toMatchObject({ type: 'result', is_error: false });
    expect(String((first as { result?: unknown }).result)).toMatch(/ok/i);
    // The renderer would have rendered these: an assistant tool_use frame and a tool_result.
    expect(outputs.some((m) => m.type === 'assistant')).toBe(true);
    expect(outputs.some((m) => m.type === 'user')).toBe(true);

    const stopped = waitFor<string>((cb) => api.onEvent(`session-status:${tabId}`, (p) => cb((p as { sessionStatus: string }).sessionStatus)), (s) => s === 'stopped', 10_000, 'stopped');
    await api.invoke('session_stop', { tabId });
    expect(await stopped).toBe('stopped');
    client.disconnect();
  }, 200_000);
});
