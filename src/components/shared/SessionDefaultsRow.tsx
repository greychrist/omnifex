import type { AccountEngine } from '@/lib/api';
import {
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  PERMISSION_OPTIONS,
  type DropdownOption,
} from '@/lib/sessionDefaultOptions';

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
  className,
}: SessionDefaultsRowProps) {
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
