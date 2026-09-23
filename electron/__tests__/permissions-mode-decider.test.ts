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

  // In acceptEdits the CLI approves in-project edits itself; what it still
  // sends is what it chose to ask a human about. Payloads below are verbatim
  // shapes captured from CLI 2.1.280 in acceptEdits mode.
  describe('acceptEdits: edits the CLI escalated reach the card', () => {
    function escalated(input: Record<string, unknown>, extra: Record<string, unknown>): AgentPermissionRequest {
      return {
        agent: 'claude',
        requestId: 'req-esc',
        kind: 'tool',
        summary: 'Write',
        payload: { tool_name: 'Write', input, tool_use_id: 'tu-esc', ...extra },
      };
    }

    it('prompts for a write outside the working directories', () => {
      const { fn, handle, respondPermission } = handlerFor('acceptEdits');
      fn(escalated({ file_path: '/opt/shared/a.txt' }, {
        decision_reason: 'Path is outside allowed working directories',
        decision_reason_type: 'workingDir',
        permission_suggestions: [
          { type: 'addDirectories', directories: ['/opt/shared'], destination: 'session' },
        ],
      }));
      expect(respondPermission).not.toHaveBeenCalled();
      expect(handle.permissionQueue).toHaveLength(1);
    });

    it('prompts for a write that escapes through a symlink', () => {
      const { fn, handle, respondPermission } = handlerFor('acceptEdits');
      fn(escalated({ file_path: '/Users/test/proj/linked/b.txt' }, {
        blocked_path: '/private/tmp/outside/b.txt',
        decision_reason_type: 'safetyCheck',
      }));
      expect(respondPermission).not.toHaveBeenCalled();
      expect(handle.permissionQueue).toHaveLength(1);
    });

    it('still auto-allows an in-project edit the CLI did not escalate (mode out of sync)', () => {
      // The decider enforces the dropdown even when the CLI never received
      // set_permission_mode — the "kept asking after I set it" fix.
      const { fn, handle, respondPermission } = handlerFor('acceptEdits');
      fn(escalated({ file_path: '/Users/test/proj/src/a.ts' }, {}));
      expect(respondPermission).toHaveBeenCalledWith('req-esc', 'allow', expect.anything());
      expect(handle.permissionQueue).toHaveLength(0);
    });

    it('offers the containing folder as the rule for an outside write, so it asks once', () => {
      const { fn, sendToRenderer } = handlerFor('acceptEdits');
      fn(escalated({ file_path: '/opt/shared/a.txt' }, { decision_reason_type: 'workingDir' }));
      const payload = sendToRenderer.mock.calls[0][1] as { permission_suggestions: Array<{ type: string; rules?: unknown[] }> };
      expect(payload.permission_suggestions[0]).toMatchObject({
        type: 'addRules',
        rules: [{ toolName: 'Edit', ruleContent: '//opt/shared/**' }],
      });
    });

    it('offers the CLI folder grant for a symlink escape — no Edit rule stops that ask', () => {
      const { fn, sendToRenderer } = handlerFor('acceptEdits');
      fn(escalated({ file_path: '/Users/test/proj/linked/b.txt' }, {
        blocked_path: '/private/tmp/outside/b.txt',
        decision_reason_type: 'safetyCheck',
        permission_suggestions: [{
          type: 'addDirectories',
          directories: ['/Users/test/proj/linked', '/tmp/outside', '/private/tmp/outside'],
          destination: 'session',
        }],
      }));
      const payload = sendToRenderer.mock.calls[0][1] as Record<string, unknown>;
      expect(payload.directory_grant).toEqual(['/Users/test/proj/linked', '/tmp/outside', '/private/tmp/outside']);
    });
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
