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
  catalogEffortLevels,
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
  configDir?: string;
  direction?: 'row' | 'column';
  className?: string;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col min-w-0 flex-1 gap-1">
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
  className,
}: SessionDefaultsRowProps) {
  const layout = direction === 'column'
    ? 'flex flex-col items-stretch gap-2'
    : 'flex items-end gap-2';
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [permsOpen, setPermsOpen] = useState(false);
  const { models, raw: modelCatalogRaw, refresh: refreshModels, refreshing: refreshingModels } = useModelCatalog(
    engine === 'claude' ? configDir : undefined,
  );

  if (engine === 'claude') {
    const selectedModelData = pickModelOption(model, models);
    const selectedRawModel = modelCatalogRaw.find((m) => m.value === model);
    const wrap = (label: string, node: React.ReactNode) => (
      <Field label={label}>{node}</Field>
    );
    return (
      <div className={`${layout} ${className ?? ''}`}>
        {wrap('Model', (
          <FormModelPicker
            selectedModelData={selectedModelData}
            models={models}
            selectedModel={model}
            onSelect={setModel}
            open={modelOpen}
            onOpenChange={setModelOpen}
            onRefresh={refreshModels}
            refreshing={refreshingModels}
          />
        ))}
        {wrap('Effort', (
          <EffortPicker
            effort={effort as EffortLevel}
            onEffortChange={(level) => { setEffort(level); }}
            open={effortOpen}
            onOpenChange={setEffortOpen}
            variant="form"
            levels={catalogEffortLevels(selectedRawModel)}
          />
        ))}
        {wrap('Permissions', (
          <PermissionPicker
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionMode}
            open={permsOpen}
            onOpenChange={setPermsOpen}
            variant="form"
          />
        ))}
      </div>
    );
  }

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
