import * as React from 'react';
import { ReadoutLabel } from '@/components/ui/readout-label';
import { useState } from 'react';
import { Gauge, ShieldCheck, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AccountEngine } from '@/lib/api';
import { Popover } from '@/components/ui/popover';
import { InlineDivider } from '@/components/ui/inline-divider';
import { POPOVER_SECTION, popoverOption } from '@/components/ui/popover-list';
import {
  EFFORT_LEVELS,
  catalogEffortLevels,
  PERMISSION_MODES,
  PermissionPickerDropdown,
  normalizePermissionMode,
} from '@/components/ControlBar';
import { ModelPickerDropdown } from '@/components/ModelPicker';
import { modelOwnColor, screenChartMode } from '@/lib/costChartPalette';
import { useModelCatalog, pickModelOption, reconcileLiveModelName, extraModelOptions } from '@/lib/modelCatalog';
import { MODEL_OPTIONS, EFFORT_OPTIONS, PERMISSION_OPTIONS, type DropdownOption } from '@/lib/sessionDefaultOptions';

function StatusBarPicker({
  id,
  icon,
  label,
  value,
  tone,
  trailing,
  valueStyle,
  title,
  content,
}: {
  id: string;
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: string;
  trailing?: React.ReactNode;
  valueStyle?: React.CSSProperties;
  title: string;
  content: (close: () => void) => React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const close = () => { setOpen(false); };
  return (
    <span data-testid={`control-${id}`} className="inline-flex items-center">
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        side="bottom"
        triggerClassName="relative inline-block"
        trigger={
          <button
            type="button"
            aria-label={`${label}: ${value}`}
            title={title}
            onClick={() => { setOpen(!open); }}
            className={cn(
              'flex items-center gap-1 rounded-sm px-0.5 -mx-0.5 cursor-pointer',
              'hover:bg-foreground/10 transition-colors',
              open && 'bg-foreground/10',
              tone,
            )}
          >
            <span aria-hidden="true" className="inline-flex">{icon}</span>
            <ReadoutLabel>{label}</ReadoutLabel>
            <span className="truncate max-w-[9rem]" style={valueStyle}>{value}</span>
            {trailing}
          </button>
        }
        content={content(close)}
      />
    </span>
  );
}

export interface SessionControlPickersProps {
  engine: AccountEngine;
  model: string;
  setModel: (v: string) => void;
  effort: string;
  setEffort: (v: string) => void;
  permissionMode: string;
  setPermissionMode: (v: string) => void;
  configDir?: string;
  activeDefaultModel?: string | null;
  /** Set when the session wasn't launched in Bypass; the CLI refuses switching to it mid-session. */
  onRestartInBypass?: () => void;
  defaultPermissionMode?: string | null;
  catalogRefreshKey?: number;
  checkingPermissions?: number;
}

function OptionList({
  options,
  value,
  onSelect,
  heading,
}: {
  options: DropdownOption[];
  value: string;
  onSelect: (id: string) => void;
  heading: string;
}): React.JSX.Element {
  return (
    <div className="w-72 flex flex-col gap-0.5">
      <div className={cn(POPOVER_SECTION, 'mb-1')}>{heading}</div>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => { onSelect(opt.id); }}
          title={opt.description}
          className={cn(popoverOption(opt.id === value), 'font-medium')}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function SessionControlPickers({
  engine,
  model,
  setModel,
  effort,
  setEffort,
  permissionMode,
  setPermissionMode,
  configDir,
  activeDefaultModel,
  onRestartInBypass,
  defaultPermissionMode,
  catalogRefreshKey,
  checkingPermissions = 0,
}: SessionControlPickersProps): React.JSX.Element {
  const { models, raw, refresh, refreshing } = useModelCatalog(engine === 'claude' ? configDir : undefined, activeDefaultModel, catalogRefreshKey);

  if (engine !== 'claude') {
    const labelOf = (opts: DropdownOption[], id: string) => opts.find((o) => o.id === id)?.label ?? id;
    return (
      <>
        <StatusBarPicker id="model" icon={<Zap className="h-3.5 w-3.5" />} label="model" value={labelOf(MODEL_OPTIONS[engine], model)} title="Model"
          content={(close) => <OptionList heading="Model" options={MODEL_OPTIONS[engine]} value={model} onSelect={(id) => { setModel(id); close(); }} />} />
        <InlineDivider data-testid="status-divider" />
        <StatusBarPicker id="effort" icon={<Gauge className="h-3.5 w-3.5" />} label="effort" value={labelOf(EFFORT_OPTIONS[engine], effort)} title="Effort"
          content={(close) => <OptionList heading="Effort" options={EFFORT_OPTIONS[engine]} value={effort} onSelect={(id) => { setEffort(id); close(); }} />} />
        <InlineDivider data-testid="status-divider" />
        <StatusBarPicker id="perms" icon={<ShieldCheck className="h-3.5 w-3.5" />} label="perms" value={labelOf(PERMISSION_OPTIONS[engine], permissionMode)} title="Permissions"
          content={(close) => <OptionList heading="Permissions" options={PERMISSION_OPTIONS[engine]} value={permissionMode} onSelect={(id) => { setPermissionMode(id); close(); }} />} />
      </>
    );
  }

  const modelData = pickModelOption(model, models);
  // The catalog's label lags the server; keep this readout matching the session card.
  const modelName = reconcileLiveModelName(modelData, activeDefaultModel);
  const modelColorId = model === 'default' ? (activeDefaultModel ?? modelData.resolvedId ?? model) : model;
  const modelNameColor = modelOwnColor(modelColorId, screenChartMode()) ?? modelOwnColor(modelData.resolvedId ?? modelData.id, screenChartMode());
  const rawModel = raw.find((m) => m.value === model);
  const effortData = EFFORT_LEVELS.find((l) => l.id === effort);
  const effortName = effortData?.name ?? effort;
  const normalizedMode = normalizePermissionMode(permissionMode);
  const modeData = PERMISSION_MODES.find((m) => m.id === normalizedMode) ?? PERMISSION_MODES[0];
  const checking = checkingPermissions > 0;
  const permsValue = checking
    ? (checkingPermissions > 1 ? `checking ${checkingPermissions}` : 'checking')
    : modeData.name;

  return (
    <>
      <StatusBarPicker
        id="model"
        icon={<Zap className="h-3.5 w-3.5" />}
        label="model"
        value={modelName}
        valueStyle={modelNameColor ? { color: modelNameColor } : undefined}
        trailing={<span className={cn('opacity-80', effortData?.color)}>{effortName}</span>}
        title={`Model: ${modelName} · Effort: ${effortName}`}
        content={(close) => (
          <ModelPickerDropdown
            models={models}
            selectedModel={model}
            onSelect={(id) => { setModel(id); close(); }}
            effort={effort}
            effortLevels={catalogEffortLevels(rawModel)}
            onEffortSelect={(level) => { setEffort(level); }}
            extras={extraModelOptions(models)}
            onRefresh={refresh}
            refreshing={refreshing}
          />
        )}
      />
      <InlineDivider data-testid="status-divider" />
      <StatusBarPicker
        id="perms"
        icon={<ShieldCheck className="h-3.5 w-3.5" />}
        label="perms"
        value={permsValue}
        tone={cn(modeData.color, checking && 'animate-pulse')}
        title={checking
          ? `Permissions: ${modeData.name} · waiting on the automatic permission check`
          : `Permissions: ${modeData.name}`}
        content={(close) => (
          <PermissionPickerDropdown
            normalizedMode={normalizedMode}
            onPermissionModeChange={setPermissionMode}
            onOpenChange={(next) => { if (!next) close(); }}
            onRestartInBypass={onRestartInBypass}
            defaultMode={defaultPermissionMode}
          />
        )}
      />
    </>
  );
}
