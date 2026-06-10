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

  it('forwards every parsed line on agent-output:<tabId>', async () => {
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
    await waitUntil(() => sendToRenderer.mock.calls.some(c => c[0] === 'agent-output:tab-1'));
    expect(sendToRenderer).toHaveBeenCalledWith('agent-output:tab-1', expect.objectContaining({ type: 'user' }));
  });

  it('routes closure carriers to claude-output-extra:<tabId>', async () => {
    const sendToRenderer = vi.fn();
    fs.writeFileSync(jsonlPath, '');
    handle = createTuiJsonlListener({
      tabId: 'tab-cc',
      projectPath: '/p',
      jsonlPath,
      sendToRenderer,
      notificationHooks: {},
      onInit: () => {},
    });
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<task-notification>x</task-notification>',
      }) + '\n',
    );
    await waitUntil(() =>
      sendToRenderer.mock.calls.some((c) => (c[0] as string).startsWith('claude-output-extra:'))
    );
    // Closure carrier must NOT go on the main channel.
    const mainCalls = sendToRenderer.mock.calls.filter(
      (c) => (c[0] as string) === 'agent-output:tab-cc'
    );
    expect(mainCalls).toHaveLength(0);
  });

  it('reports status running on turn events and idle on result/init', async () => {
    const onStatusChange = vi.fn();
    fs.writeFileSync(jsonlPath, '');
    handle = createTuiJsonlListener({
      tabId: 'tab-status',
      projectPath: '/p',
      jsonlPath,
      sendToRenderer: vi.fn(),
      notificationHooks: {},
      onInit: () => {},
      onStatusChange,
    });
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }) + '\n' +
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\n',
    );
    await waitUntil(() => onStatusChange.mock.calls.length >= 3);
    expect(onStatusChange.mock.calls.map((c) => c[0])).toEqual(['idle', 'running', 'idle']);
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

  it('fires notification on assistant message with terminal stop_reason', async () => {
    const showNotification = vi.fn();
    const sendToRenderer = vi.fn();
    fs.writeFileSync(jsonlPath, '');
    handle = createTuiJsonlListener({
      tabId: 'tab-synth',
      projectPath: '/Users/test/myproj',
      jsonlPath,
      sendToRenderer,
      notificationHooks: { showNotification },
      onInit: () => {},
    });
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sid',
        timestamp: '2026-05-24T12:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'all done' }],
          stop_reason: 'end_turn',
        },
      }) + '\n',
    );
    await waitUntil(() => showNotification.mock.calls.length > 0);
    expect(showNotification).toHaveBeenCalledWith(
      'OmniFex — myproj',
      'all done',
      false,
      { tabId: 'tab-synth' },
    );
  });

  it('does NOT fire notification on assistant with non-terminal stop_reason (tool_use)', async () => {
    const showNotification = vi.fn();
    fs.writeFileSync(jsonlPath, '');
    handle = createTuiJsonlListener({
      tabId: 'tab-tu',
      projectPath: '/p',
      jsonlPath,
      sendToRenderer: vi.fn(),
      notificationHooks: { showNotification },
      onInit: () => {},
    });
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sid',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'using a tool' }],
          stop_reason: 'tool_use',
        },
      }) + '\n',
    );
    await wait(400);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('emits onControlState with the model from an assistant line, deduped', async () => {
    const onControlState = vi.fn();
    fs.writeFileSync(jsonlPath, '');
    handle = createTuiJsonlListener({
      tabId: 'tab-model',
      projectPath: '/p',
      jsonlPath,
      sendToRenderer: vi.fn(),
      notificationHooks: {},
      onInit: () => {},
      onControlState,
    });
    // Two assistant lines with the SAME model, then one with a new model.
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-06-10T00:00:00Z', message: { role: 'assistant', content: [], model: 'claude-opus-4-8' } }) + '\n' +
      JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-06-10T00:00:01Z', message: { role: 'assistant', content: [], model: 'claude-opus-4-8' } }) + '\n' +
      JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-06-10T00:00:02Z', message: { role: 'assistant', content: [], model: 'claude-sonnet-4-6' } }) + '\n',
    );
    await waitUntil(() => onControlState.mock.calls.length >= 2);
    const models = onControlState.mock.calls
      .map((c) => (c[0] as { model?: string }).model)
      .filter(Boolean);
    expect(models).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
  });

  it('emits onControlState with permissionMode from a permission-mode line, deduped', async () => {
    const onControlState = vi.fn();
    fs.writeFileSync(jsonlPath, '');
    handle = createTuiJsonlListener({
      tabId: 'tab-perm',
      projectPath: '/p',
      jsonlPath,
      sendToRenderer: vi.fn(),
      notificationHooks: {},
      onInit: () => {},
      onControlState,
    });
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' }) + '\n' +
      JSON.stringify({ type: 'permission-mode', permissionMode: 'plan' }) + '\n' +
      JSON.stringify({ type: 'permission-mode', permissionMode: 'acceptEdits' }) + '\n',
    );
    await waitUntil(() => onControlState.mock.calls.length >= 2);
    const modes = onControlState.mock.calls
      .map((c) => (c[0] as { permissionMode?: string }).permissionMode)
      .filter(Boolean);
    expect(modes).toEqual(['plan', 'acceptEdits']);
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
