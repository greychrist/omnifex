import { EFFORT_LEVELS, PERMISSION_MODES, normalizePermissionMode } from '@/components/ControlBar';
import { recommendedDefaultModel, resolveActualModelName } from '@/lib/modelCatalog';
import type { Model } from '@/components/ModelPicker';
import type { SessionModelInfo } from '@/lib/api';

export interface SessionControlSummaryInput {
  model: string;
  liveModel?: string | null;
  /** The settings.json `model` pin: what "default" resolves to when OmniFex omits --model. */
  accountDefaultModel?: string | null;
  models: Model[];
  raw?: SessionModelInfo[] | null;
  effort: string;
  permissionMode: string;
}

/** The live model beats even an explicit selection (on a reopened tab that is only a seed); "Default" only when no signal exists. */
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
