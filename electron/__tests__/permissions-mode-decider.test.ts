// @vitest-environment node
//
// The bottom-bar permission dropdown changes handle.permissionMode live, and
// the decider reads it per-request (currentPermissionMode). These tests pin
// the auto-decision behavior for each mode so "change the dropdown, nothing
// happens" can't regress: the decider must actually act on the mode rather
// than prompt identically for everything except bypassPermissions.
import { describe, it, expect, vi } from 'vitest';
import { createPermissionRequestHandler } from '../services/sessions/permissions';
import type { SessionHandle } from '../services/sessions/types';
import type { AgentPermissionRequest } from '../services/agents/types';

function makeHandle(permissionMode: string) {
  const respondPermission = vi.fn(async () => {});
  const handle = {
    mode: 'rich',
    engine: { respondPermission },
    permissionMode,
    projectPath: '/Users/test/proj',
    permissionQueue: [] as unknown[],
  } as unknown as SessionHandle;
  return { handle, respondPermission };
}

function req(toolName: string, input: Record<string, unknown>): AgentPermissionRequest {
  return {
    agent: 'claude',
    requestId: `req-${toolName}`,
    kind: 'tool',
    summary: toolName,
    payload: { tool_name: toolName, input, tool_use_id: `tu-${toolName}` },
  };
}

function handlerFor(mode: string) {
  const { handle, respondPermission } = makeHandle(mode);
  const sendToRenderer = vi.fn();
  const notificationHooks = { showNotification: vi.fn(), incrementUnread: vi.fn() };
  const fn = createPermissionRequestHandler(
    handle,
    'tab-1',
    sendToRenderer as never,
    notificationHooks as never,
    null,
  );
  return { fn, handle, respondPermission, sendToRenderer };
}

describe('permission-mode decider (auto allow/deny vs prompt)', () => {
  it('bypassPermissions: auto-allows any tool, never enqueues', () => {
    const { fn, handle, respondPermission } = handlerFor('bypassPermissions');
    fn(req('Bash', { command: 'rm -rf build' }));
    expect(respondPermission).toHaveBeenCalledWith('req-Bash', 'allow', expect.anything());
    expect(handle.permissionQueue).toHaveLength(0);
  });

  it('acceptEdits: auto-allows file-edit tools without prompting', () => {
    const { fn, handle, respondPermission } = handlerFor('acceptEdits');
    fn(req('Edit', { file_path: '/Users/test/proj/src/a.ts' }));
    expect(respondPermission).toHaveBeenCalledWith('req-Edit', 'allow', expect.anything());
    expect(handle.permissionQueue).toHaveLength(0);
  });

  it('acceptEdits: still prompts for non-edit tools (e.g. Bash)', () => {
    const { fn, handle, respondPermission, sendToRenderer } = handlerFor('acceptEdits');
    fn(req('Bash', { command: 'curl example.com' }));
    expect(respondPermission).not.toHaveBeenCalled();
    expect(handle.permissionQueue).toHaveLength(1);
    expect(sendToRenderer).toHaveBeenCalledWith(
      'agent-output:tab-1',
      expect.objectContaining({ type: 'permission_request' }),
    );
  });

  it('dontAsk: auto-denies an unmatched tool, never enqueues', () => {
    const { fn, handle, respondPermission } = handlerFor('dontAsk');
    fn(req('Bash', { command: 'ls' }));
    expect(respondPermission).toHaveBeenCalledWith('req-Bash', 'deny', expect.anything());
    expect(handle.permissionQueue).toHaveLength(0);
  });

  it('default: prompts (enqueues), does not auto-decide', () => {
    const { fn, handle, respondPermission } = handlerFor('default');
    fn(req('Edit', { file_path: '/Users/test/proj/src/a.ts' }));
    expect(respondPermission).not.toHaveBeenCalled();
    expect(handle.permissionQueue).toHaveLength(1);
  });
});
