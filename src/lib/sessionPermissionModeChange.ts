// A refused switch must roll the picker back, as main does, or it shows a mode the session is not in.

import type { JsonlNode } from '@/types/jsonl';

export interface ChangeSessionPermissionModeDeps {
  tabId: string;
  hasLiveSession: boolean;
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
  // jsonl-tail never forwards the persisted permission-mode line live, so this marker is the live feedback; the two never coexist.
  deps.appendMessage({
    kind: 'control-change',
    control: 'permission',
    value: String(mode),
    sessionId: deps.tabId,
    receivedAt: new Date().toISOString(),
  });
}
