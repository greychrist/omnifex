// @vitest-environment node
//
// `suppress_always_allow_rule` on the CLI's can_use_tool request.
//
// The CLI sets it when granting a persistent rule for this ask would write
// a rule broader than the ask's own verb — its own schema says "the dialog
// must not offer the persistent 'don't ask again' row for this ask", and its
// TUI drops the whole standing row when it fires (2.1.235 widened the cases
// via `contentWithheld`, which never reaches a stdio host).
//
// OmniFex is a `--permission-prompt-tool stdio` host, so this flag is the
// only signal it gets. These tests pin that we (a) forward it to the
// renderer and (b) stop injecting our own fallback rule, which for an MCP
// tool is a bare whole-tool allow — exactly the grant the flag exists to
// prevent.
import { describe, it, expect, vi } from 'vitest';
import { createPermissionRequestHandler } from '../services/sessions/permissions';
import type { SessionHandle } from '../services/sessions/types';
import type { AgentPermissionRequest } from '../services/agents/types';

function handlerHarness() {
  const handle = {
    mode: 'rich',
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
    { showNotification: vi.fn(), incrementUnread: vi.fn() } as never,
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
  } as AgentPermissionRequest;
}

/** The `permission_request` envelope the handler pushed to the renderer. */
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
    // 2.1.235's notebook/large-diff cases ride Edit and NotebookEdit, where
    // the fallback rule is normally the SOLE source of the card's rule.
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
    // The CLI's own recommendation still survives — we withhold our rule,
    // we don't discard what it sent.
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
    // The field is optional on the wire; only an explicit `true` withholds
    // the standing grant. A stray string must not silently disable rules.
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
