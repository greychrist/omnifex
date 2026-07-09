// One-line "Fable 5 | High | Auto Review" rollup of the live session's
// model / effort / permission state, shown in thin small type on the
// SessionCard so the active controls are visible without opening the
// context popover.

import { EFFORT_LEVELS, PERMISSION_MODES, normalizePermissionMode } from '@/components/ControlBar';
import { recommendedDefaultModel, resolveActualModelName } from '@/lib/modelCatalog';
import type { Model } from '@/components/ModelPicker';
import type { SessionModelInfo } from '@/lib/api';

export interface SessionControlSummaryInput {
  /** Current model selection — an alias ('default', 'sonnet'), a concrete CLI
   *  id detected from a live TUI session, or 'default' for Account Default. */
  model: string;
  /** Concrete model id the session is actually running — from the CLI's
   *  get_context_usage response or the last assistant JSONL line. Resolves a
   *  'default' selection to the real model; beats the settings pin. */
  liveModel?: string | null;
  /** The account's settings.json `model` pin, if any — what "default"
   *  resolves to when OmniFex omits --model. Fallback when no live signal. */
  accountDefaultModel?: string | null;
  /** Picker catalog (relabeled or not — only non-default entries are read). */
  models: Model[];
  /** Raw CLI catalog for display-name resolution. */
  raw?: SessionModelInfo[] | null;
  effort: string;
  permissionMode: string;
}

/**
 * Roll the three live controls into "Model | Effort | Permission". The model
 * segment names what actually runs: the live session model first
 * (get_context_usage / assistant JSONL — it beats even an explicit selection,
 * which on a reopened tab is just a hardcoded seed), then the selection, then
 * the settings.json pin, then the catalog's own recommended-default
 * identification. "Default" appears only as a last resort, when no signal
 * exists at all (session not started, no reply yet, no usable catalog).
 */
export function sessionControlSummary({
  model,
  liveModel,
  accountDefaultModel,
  models,
  raw,
  effort,
  permissionMode,
}: SessionControlSummaryInput): string {
  const live = liveModel && liveModel !== 'default' ? liveModel : null;
  const selected = model !== 'default' ? model : null;
  const pinned =
    accountDefaultModel && accountDefaultModel !== 'default' ? accountDefaultModel : null;
  const actual = live ?? selected ?? pinned;
  const modelLabel = actual
    ? resolveActualModelName(actual, models, raw)
    : recommendedDefaultModel(raw)?.displayName || 'Default';

  const effortLabel = EFFORT_LEVELS.find((l) => l.id === effort)?.name ?? effort;

  const normalizedMode = normalizePermissionMode(permissionMode);
  const permissionLabel =
    PERMISSION_MODES.find((m) => m.id === normalizedMode)?.name ?? permissionMode;

  return `${modelLabel} | ${effortLabel} | ${permissionLabel}`;
}
