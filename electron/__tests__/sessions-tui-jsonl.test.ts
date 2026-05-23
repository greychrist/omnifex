// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTuiJsonlListener, type TuiJsonlHandle } from '../services/sessions/tui-jsonl';

function wait(ms = 300): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await wait(30);
  }
  return predicate();
}

describe('createTuiJsonlListener', () => {
  let tmpDir: string;
  let jsonlPath: string;
  let handle: TuiJsonlHandle | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-tui-jsonl-'));
    jsonlPath = path.join(tmpDir, 'session.jsonl');
  });

  afterEach(() => {
    handle?.stop();
    handle = null;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('forwards every parsed line on session-jsonl:<tabId>', async () => {
    const sendToRenderer = vi.fn();
    fs.writeFileSync(jsonlPath, '');
    handle = createTuiJsonlListener({
      tabId: 'tab-1',
      projectPath: '/p',
      jsonlPath,
      sendToRenderer,
      notificationHooks: {},
      onInit: () => {},
    });
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
    );
    await waitUntil(() => sendToRenderer.mock.calls.some(c => c[0] === 'session-jsonl:tab-1'));
    expect(sendToRenderer).toHaveBeenCalledWith('session-jsonl:tab-1', expect.objectContaining({ type: 'user' }));
  });

  it('reports sessionId via onInit when system:init lands, firing exactly once', async () => {
    const onInit = vi.fn();
    fs.writeFileSync(jsonlPath, '');
    handle = createTuiJsonlListener({
      tabId: 'tab-2',
      projectPath: '/p',
      jsonlPath,
      sendToRenderer: vi.fn(),
      notificationHooks: {},
      onInit,
    });
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-xyz' }) + '\n',
    );
    await waitUntil(() => onInit.mock.calls.length > 0);
    expect(onInit).toHaveBeenCalledWith('sid-xyz');
    expect(onInit).toHaveBeenCalledTimes(1);

    // A second system:init line must not produce a second call.
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-xyz' }) + '\n',
    );
    await wait(400);
    expect(onInit).toHaveBeenCalledTimes(1);
  });

  it('fires the notification helper on a result line', async () => {
    const showNotification = vi.fn();
    const sendToRenderer = vi.fn();
    fs.writeFileSync(jsonlPath, '');
    handle = createTuiJsonlListener({
      tabId: 'tab-3',
      projectPath: '/Users/test/myproj',
      jsonlPath,
      sendToRenderer,
      notificationHooks: { showNotification },
      onInit: () => {},
    });
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Task complete' }) + '\n',
    );
    await waitUntil(() => showNotification.mock.calls.length > 0);
    expect(showNotification).toHaveBeenCalledWith(
      'OmniFex — myproj',
      'Task complete',
      false,
      { tabId: 'tab-3' },
    );
  });
});
