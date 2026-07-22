// Mid-session model-change plumbing, extracted from AgentSession so the
// staleness contract is testable: `sessionControlSummary` prefers the live
// model signal (`contextUsage.model`) over the picker selection, so any
// confirmed model change MUST also update that live signal or the header
// keeps naming the old model until the next turn's result refreshes it.

import type { JsonlNode } from '@/types/jsonl';
import type { SessionContextUsage } from '@/lib/api';
import type { EffortLevel } from '@/components/ControlBar';

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

export interface MirrorControlStateDeps {
  setSelectedModel(model: string): void;
  setPermissionMode(mode: string): void;
  setEffort(level: EffortLevel): void;
  setContextUsage(
    updater: (prev: SessionContextUsage | null) => SessionContextUsage | null,
  ): void;
}

/** The CLI's EffortLevel values — the only ones the typed picker state and
 *  EFFORT_LEVELS catalog know. Detected values outside this set (a future
 *  CLI addition) are dropped rather than pushed into the picker. */
const KNOWN_EFFORT_LEVELS: ReadonlySet<string> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * Mirror a `session-control-state` event (model / permission-mode / effort
 * switches the user makes inside a live TUI terminal, detected from the
 * session JSONL) into renderer state. Alongside the picker selection, the
 * detected model is patched onto any existing contextUsage snapshot: a
 * snapshot left over from a rich-mode stint would otherwise keep winning in
 * the header summary with the old model, and TUI mode has no engine to
 * refetch from.
 */
export function mirrorControlState(
  payload: { model?: string; permissionMode?: string; effort?: string } | undefined,
  deps: MirrorControlStateDeps,
): void {
  const model = payload?.model;
  if (typeof model === 'string' && model.length > 0) {
    // selectedModel may become a concrete CLI id (e.g. `claude-opus-4-8`);
    // SessionDefaultsRow's pickModelOption resolves it to the right picker
    // option for display.
    deps.setSelectedModel(model);
    deps.setContextUsage((prev) => (prev ? { ...prev, model } : prev));
  }
  if (typeof payload?.permissionMode === 'string' && payload.permissionMode.length > 0) {
    deps.setPermissionMode(payload.permissionMode);
  }
  const effort = payload?.effort;
  if (typeof effort === 'string' && KNOWN_EFFORT_LEVELS.has(effort)) {
    deps.setEffort(effort as EffortLevel);
  }
}
