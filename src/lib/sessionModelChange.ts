// Mid-session model-change plumbing, extracted from AgentSession so the
// staleness contract is testable: `sessionControlSummary` prefers the live
// model signal (`contextUsage.model`) over the picker selection, so any
// confirmed model change MUST also update that live signal or the header
// keeps naming the old model until the next turn's result refreshes it.

import type { JsonlNode } from '@/types/jsonl';
import type { SessionContextUsage } from '@/lib/api';

export interface ChangeSessionModelDeps {
  tabId: string;
  /** True when a CLI session is running and can take control requests. */
  hasLiveSession: boolean;
  api: {
    sessionSetModel(tabId: string, model: string): Promise<void>;
    sessionContextUsage(tabId: string): Promise<SessionContextUsage | null>;
  };
  setSelectedModel(model: string): void;
  setContextUsage(usage: SessionContextUsage): void;
  appendMessage(node: JsonlNode): void;
  onError(err: unknown): void;
}

/**
 * Apply a model change from the popover picker. Updates the selection
 * synchronously; on a live session, pushes the switch to the CLI via
 * set_model, drops a control-change transcript marker (model changes are
 * out-of-band control requests that never reach the JSONL, so the live-only
 * marker is the only scrollback record), then refreshes context usage —
 * get_context_usage reports the new model as soon as set_model resolves
 * (verified against CLI 2.1.217), which keeps the header summary honest.
 */
export async function changeSessionModel(
  newModel: string,
  deps: ChangeSessionModelDeps,
): Promise<void> {
  deps.setSelectedModel(newModel);
  if (!deps.hasLiveSession) return;
  try {
    await deps.api.sessionSetModel(deps.tabId, newModel);
    deps.appendMessage({
      kind: 'control-change',
      control: 'model',
      value: String(newModel),
      sessionId: deps.tabId,
      receivedAt: new Date().toISOString(),
    });
    const usage = await deps.api.sessionContextUsage(deps.tabId);
    if (usage) deps.setContextUsage(usage);
  } catch (err) {
    deps.onError(err);
  }
}
