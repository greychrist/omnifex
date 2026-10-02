// Mid-session permission-mode plumbing, extracted from AgentSession so the
// rollback contract is testable, the way sessionModelChange.ts is.
//
// Main sets its own remembered mode before asking the CLI and rolls it back if
// the CLI refuses (sessions/queries.ts). The picker must follow suit: left on
// the refused mode, it shows a mode the session is not in — which is how a
// mid-session switch to Bypass used to look applied while the CLI ran on.

import type { JsonlNode } from '@/types/jsonl';

export interface ChangeSessionPermissionModeDeps {
  tabId: string;
  /** True when a CLI session is running and can take control requests. */
  hasLiveSession: boolean;
  /** The picker's mode before this change, restored if the switch is refused. */
  previous: string;
  api: {
    sessionSetPermissionMode(tabId: string, mode: string): Promise<void>;
  };
  setPermissionMode(mode: string): void;
  appendMessage(node: JsonlNode): void;
  onError(err: unknown): void;
}

export async function changeSessionPermissionMode(
  mode: string,
  deps: ChangeSessionPermissionModeDeps,
): Promise<void> {
  deps.setPermissionMode(mode);
  // No session yet: the picker's mode is what the next launch spawns with.
  if (!deps.hasLiveSession) return;
  try {
    await deps.api.sessionSetPermissionMode(deps.tabId, mode);
  } catch (err) {
    deps.setPermissionMode(deps.previous);
    deps.onError(err);
    return;
  }
  // Live transcript marker. The CLI DOES persist a `permission-mode` JSONL
  // line, but jsonl-tail only forwards closure-carriers
  // (queue-operation/attachment) to the live stream — so the persisted line
  // shows up only on resume, never live. This synthetic marker gives the
  // immediate feedback; the persisted line covers scrollback after resume.
  // They never coexist in one view, so no double.
  deps.appendMessage({
    kind: 'control-change',
    control: 'permission',
    value: String(mode),
    sessionId: deps.tabId,
    receivedAt: new Date().toISOString(),
  });
}
