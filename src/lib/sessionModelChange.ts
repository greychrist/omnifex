// A confirmed change must also update contextUsage.model: the control summary prefers it over the selection.

import type { JsonlNode } from '@/types/jsonl';
import type { SessionContextUsage } from '@/lib/api';

export interface ChangeSessionModelDeps {
  tabId: string;
  hasLiveSession: boolean;
  previous: string;
  api: {
    sessionSetModel(tabId: string, model: string): Promise<string | null>;
    sessionContextUsage(tabId: string): Promise<SessionContextUsage | null>;
  };
  setSelectedModel(model: string): void;
  setContextUsage(usage: SessionContextUsage): void;
  appendMessage(node: JsonlNode): void;
  onError(err: unknown): void;
}

/** Model changes never reach the JSONL, so the live marker is the only scrollback record. */
export async function changeSessionModel(
  newModel: string,
  deps: ChangeSessionModelDeps,
): Promise<void> {
  deps.setSelectedModel(newModel);
  if (!deps.hasLiveSession) return;
  let resolved: string | null;
  try {
    resolved = await deps.api.sessionSetModel(deps.tabId, newModel);
  } catch (err) {
    deps.setSelectedModel(deps.previous);
    deps.onError(err);
    return;
  }
  deps.appendMessage({
    kind: 'control-change',
    control: 'model',
    value: resolved && resolved !== newModel ? `${newModel} (${resolved})` : String(newModel),
    sessionId: deps.tabId,
    receivedAt: new Date().toISOString(),
  });
  try {
    const usage = await deps.api.sessionContextUsage(deps.tabId);
    if (usage) deps.setContextUsage(usage);
  } catch (err) {
    deps.onError(err);
  }
}
