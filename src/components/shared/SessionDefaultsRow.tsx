import { useState } from 'react';
import type { AccountEngine } from '@/lib/api';
import {
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  PERMISSION_OPTIONS,
  type DropdownOption,
} from '@/lib/sessionDefaultOptions';
import {
  EffortPicker,
  PermissionPicker,
  type EffortLevel,
} from '@/components/ControlBar';
import { FormModelPicker } from '@/components/ModelPicker';
import { useModelCatalog, pickModelOption } from '@/lib/modelCatalog';

export interface SessionDefaultsRowProps {
  engine: AccountEngine;
  model: string;
  setModel: (v: string) => void;
  effort: string;
  setEffort: (v: string) => void;
  permissionMode: string;
  setPermissionMode: (v: string) => void;
  /**
   * Config dir of the account these defaults belong to. When set (and the
   * engine is Claude) the model picker shows that account's live CLI model
   * catalog instead of the static fallback.
   */
  configDir?: string;
  /**
   * 'row' (default) lays the three fields out side by side; 'column' stacks
   * them full-width — used in narrow containers like the SessionCard
   * context popover where a row truncates every trigger.
   */
  direction?: 'row' | 'column';
  /**
   * Renders the pickers read-only. Used for live TUI sessions, where the
   * terminal — not OmniFex — owns model / effort / permission, so the pickers
   * mirror the CLI's state (auto-detected) but can't drive it.
   */
  disabled?: boolean;
  className?: string;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 min-w-0 flex-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

interface DropdownProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
}

// Plain <select> used for the Codex engine, whose model / effort / permission
// option sets have no shared stylized (icon + color) picker component yet.
function Dropdown({ id, label, value, onChange, options }: DropdownProps) {
  return (
    <div className="flex flex-col gap-1 min-w-0 flex-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => { onChange(e.target.value); }}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
      >
        {options.map((opt) => (
          <option key={opt.id} value={opt.id} title={opt.description}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SessionDefaultsRow({
  engine,
  model,
  setModel,
  effort,
  setEffort,
  permissionMode,
  setPermissionMode,
  configDir,
  direction = 'row',
  disabled = false,
  className,
}: SessionDefaultsRowProps) {
  const layout =
    direction === 'column' ? 'flex flex-col items-stretch gap-2' : 'flex items-end gap-2';
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [permsOpen, setPermsOpen] = useState(false);
  const { models: modelList, raw: modelCatalogRaw } = useModelCatalog(
    engine === 'claude' ? configDir : undefined,
  );

  // Claude reuses the same stylized, icon-bearing pickers as the new-session
  // page (ControlBar + ModelPicker). Reusing them means the permission option
  // set (all six CLI modes) and the per-mode colors stay in one place and any
  // fix propagates to both surfaces.
  if (engine === 'claude') {
    // pickModelOption bridges concrete CLI ids (e.g. `claude-opus-4-8`,
    // detected from a live TUI session) to the picker's alias options.
    const selectedModelData = pickModelOption(model, modelList);
    const selectedRawModel = modelCatalogRaw.find((m) => m.value === model);
    return (
      <div className={`${layout} ${className ?? ''}`}>
        <Field label="Model">
          <FormModelPicker
            selectedModelData={selectedModelData}
            models={modelList}
            selectedModel={model}
            onSelect={setModel}
            open={modelOpen}
            onOpenChange={setModelOpen}
            disabled={disabled}
          />
        </Field>
        <Field label="Effort">
          <EffortPicker
            effort={effort as EffortLevel}
            onEffortChange={(level) => { setEffort(level); }}
            open={effortOpen}
            onOpenChange={setEffortOpen}
            variant="form"
            levels={selectedRawModel?.supportedEffortLevels}
            disabled={disabled}
          />
        </Field>
        <Field label="Permissions">
          <PermissionPicker
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionMode}
            open={permsOpen}
            onOpenChange={setPermsOpen}
            variant="form"
            disabled={disabled}
          />
        </Field>
        {disabled && (
          <p className="text-[10px] leading-snug text-muted-foreground">
            Managed by the terminal — change model with <code>/model</code>,
            effort/permissions with the CLI's own controls. These mirror the
            live session.
          </p>
        )}
      </div>
    );
  }

  // Codex: plain selects fed by the engine-keyed option lists.
  return (
    <div className={`${layout} ${className ?? ''}`}>
      <Dropdown
        id="session-defaults-model"
        label="Model"
        value={model}
        onChange={setModel}
        options={MODEL_OPTIONS[engine]}
      />
      <Dropdown
        id="session-defaults-effort"
        label="Effort"
        value={effort}
        onChange={setEffort}
        options={EFFORT_OPTIONS[engine]}
      />
      <Dropdown
        id="session-defaults-permissions"
        label="Permissions"
        value={permissionMode}
        onChange={setPermissionMode}
        options={PERMISSION_OPTIONS[engine]}
      />
    </div>
  );
}
