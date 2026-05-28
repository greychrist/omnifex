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
import { FormModelPicker, MODELS } from '@/components/ModelPicker';

export interface SessionDefaultsRowProps {
  engine: AccountEngine;
  model: string;
  setModel: (v: string) => void;
  effort: string;
  setEffort: (v: string) => void;
  permissionMode: string;
  setPermissionMode: (v: string) => void;
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
  className,
}: SessionDefaultsRowProps) {
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [permsOpen, setPermsOpen] = useState(false);

  // Claude reuses the same stylized, icon-bearing pickers as the new-session
  // page (ControlBar + ModelPicker). Reusing them means the permission option
  // set (all six SDK modes) and the per-mode colors stay in one place and any
  // fix propagates to both surfaces.
  if (engine === 'claude') {
    const selectedModelData = MODELS.find((m) => m.id === model) ?? MODELS[0];
    return (
      <div className={`flex items-end gap-2 ${className ?? ''}`}>
        <Field label="Model">
          <FormModelPicker
            selectedModelData={selectedModelData}
            models={MODELS}
            selectedModel={model}
            onSelect={setModel}
            open={modelOpen}
            onOpenChange={setModelOpen}
          />
        </Field>
        <Field label="Effort">
          <EffortPicker
            effort={effort as EffortLevel}
            onEffortChange={(level) => { setEffort(level); }}
            open={effortOpen}
            onOpenChange={setEffortOpen}
            variant="form"
          />
        </Field>
        <Field label="Permissions">
          <PermissionPicker
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionMode}
            open={permsOpen}
            onOpenChange={setPermsOpen}
            variant="form"
          />
        </Field>
      </div>
    );
  }

  // Codex: plain selects fed by the engine-keyed option lists.
  return (
    <div className={`flex items-end gap-2 ${className ?? ''}`}>
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
