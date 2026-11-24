// @vitest-environment node
// The CLI sets `suppress_always_allow_rule` when a persistent rule would be
// broader than the ask's own verb; its dialog then drops the standing row.
import { describe, it, expect, vi } from 'vitest';
import { createPermissionRequestHandler } from '../services/sessions/permissions';
import type { SessionHandle } from '../services/sessions/types';
import type { AgentPermissionRequest } from '../services/agents/types';

function handlerHarness() {
  const handle = {
    engine: { respondPermission: vi.fn(async () => {}) },
    permissionMode: 'default',
    projectPath: '/Users/test/proj',
    permissionQueue: [] as unknown[],
  } as unknown as SessionHandle;
  const sendToRenderer = vi.fn();
  const fn = createPermissionRequestHandler(
    handle,
    'tab-1',
    sendToRenderer as never,
    null,
  );
  return { fn, handle, sendToRenderer };
}

function req(payload: Record<string, unknown>): AgentPermissionRequest {
  return {
    agent: 'claude',
    requestId: 'req-1',
    kind: 'tool',
    summary: 'tool',
    payload,
  };
}

function rendererPayload(sendToRenderer: ReturnType<typeof vi.fn>) {
  const call = sendToRenderer.mock.calls.find(
    ([, msg]) => (msg as { type?: string })?.type === 'permission_request',
  );
  return call?.[1] as {
    suppress_always_allow_rule?: boolean;
    permission_suggestions?: unknown[];
  };
}

function hasRuleSuggestion(suggestions: unknown[] | undefined): boolean {
  return (suggestions ?? []).some(
    (s) =>
      (s as { type?: string })?.type === 'addRules' &&
      Array.isArray((s as { rules?: unknown[] }).rules) &&
      (s as { rules: unknown[] }).rules.length > 0,
  );
}

describe('suppress_always_allow_rule', () => {
  it('forwards the flag to the renderer', () => {
    const { fn, sendToRenderer } = handlerHarness();
    fn(
      req({
        tool_name: 'mcp__acme__deploy',
        input: { target: 'prod' },
        tool_use_id: 'tu-1',
        suppress_always_allow_rule: true,
      }),
    );
    expect(rendererPayload(sendToRenderer).suppress_always_allow_rule).toBe(true);
  });

  it('does not inject our fallback rule when the flag is set', () => {
    // An MCP tool has no rule content to narrow on, so buildDefaultRule
    // falls through to a bare whole-tool rule. That is precisely the grant
    // the CLI told us not to offer.
    const { fn, sendToRenderer } = handlerHarness();
    fn(
      req({
        tool_name: 'mcp__acme__deploy',
        input: { target: 'prod' },
        tool_use_id: 'tu-1',
        suppress_always_allow_rule: true,
      }),
    );
    expect(hasRuleSuggestion(rendererPayload(sendToRenderer).permission_suggestions)).toBe(false);
  });

  it('does not inject our fallback rule for a file edit when the flag is set', () => {
    // For Edit and NotebookEdit the fallback rule is normally the card's only rule.
    const { fn, sendToRenderer } = handlerHarness();
    fn(
      req({
        tool_name: 'Edit',
        input: { file_path: '/Users/test/proj/src/a.ts' },
        tool_use_id: 'tu-2',
        suppress_always_allow_rule: true,
        permission_suggestions: [
          { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        ],
      }),
    );
    const payload = rendererPayload(sendToRenderer);
    expect(hasRuleSuggestion(payload.permission_suggestions)).toBe(false);
    expect(payload.permission_suggestions).toContainEqual({
      type: 'setMode',
      mode: 'acceptEdits',
      destination: 'session',
    });
  });

  it('still injects the fallback rule when the flag is absent', () => {
    const { fn, sendToRenderer } = handlerHarness();
    fn(
      req({
        tool_name: 'Edit',
        input: { file_path: '/Users/test/proj/src/a.ts' },
        tool_use_id: 'tu-3',
      }),
    );
    const payload = rendererPayload(sendToRenderer);
    expect(hasRuleSuggestion(payload.permission_suggestions)).toBe(true);
    expect(payload.suppress_always_allow_rule).toBeUndefined();
  });

  it('treats a non-boolean value as unset rather than truthy', () => {
    const { fn, sendToRenderer } = handlerHarness();
    fn(
      req({
        tool_name: 'Edit',
        input: { file_path: '/Users/test/proj/src/a.ts' },
        tool_use_id: 'tu-4',
        suppress_always_allow_rule: 'yes',
      }),
    );
    const payload = rendererPayload(sendToRenderer);
    expect(payload.suppress_always_allow_rule).toBeUndefined();
    expect(hasRuleSuggestion(payload.permission_suggestions)).toBe(true);
  });
});

// CLI 2.1.325: a Bash ask with no rule worth saving carries no `addRules`
// suggestion at all.
describe('Bash ask with no rule from the CLI', () => {
  it('offers no invented rule and withholds the standing row', () => {
    const { fn, sendToRenderer } = handlerHarness();
    fn(
      req({
        tool_name: 'Bash',
        input: { command: 'f=$(grep -l x *.jsonl); echo "$f"' },
        tool_use_id: 'tu-b1',
      }),
    );
    const payload = rendererPayload(sendToRenderer);
    expect(hasRuleSuggestion(payload.permission_suggestions)).toBe(false);
    expect(payload.suppress_always_allow_rule).toBe(true);
  });

  it("keeps the CLI's non-rule suggestions", () => {
    const { fn, sendToRenderer } = handlerHarness();
    const setMode = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
    fn(
      req({
        tool_name: 'Bash',
        input: { command: 'cd a && make' },
        tool_use_id: 'tu-b2',
        permission_suggestions: [setMode],
      }),
    );
    expect(rendererPayload(sendToRenderer).permission_suggestions).toEqual([setMode]);
  });

  it("passes the CLI's own Bash rule through untouched", () => {
    const { fn, sendToRenderer } = handlerHarness();
    const cliRule = {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'npm run build:*' }],
      behavior: 'allow',
      destination: 'localSettings',
    };
    fn(
      req({
        tool_name: 'Bash',
        input: { command: 'npm run build' },
        tool_use_id: 'tu-b3',
        permission_suggestions: [cliRule],
      }),
    );
    const payload = rendererPayload(sendToRenderer);
    expect(payload.permission_suggestions).toEqual([cliRule]);
    expect(payload.suppress_always_allow_rule).toBeUndefined();
  });

  it('still offers the folder grant for a Bash ask outside the working directories', () => {
    const { fn, sendToRenderer } = handlerHarness();
    fn(
      req({
        tool_name: 'Bash',
        input: { command: 'touch /tmp/x/y' },
        tool_use_id: 'tu-b4',
        blocked_path: '/tmp/x/y',
        permission_suggestions: [
          { type: 'addDirectories', directories: ['/tmp/x'], destination: 'session' },
        ],
      }),
    );
    const payload = rendererPayload(sendToRenderer) as {
      suppress_always_allow_rule?: boolean;
      directory_grant?: string[];
    };
    expect(payload.directory_grant).toEqual(['/tmp/x']);
    expect(payload.suppress_always_allow_rule).toBeUndefined();
  });
});
