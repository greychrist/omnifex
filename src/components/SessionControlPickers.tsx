import * as React from 'react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { AccountEngine } from '@/lib/api';
import { Popover } from '@/components/ui/popover';
import { InlineDivider } from '@/components/ui/inline-divider';
import {
  EFFORT_LEVELS,
  catalogEffortLevels,
  PERMISSION_MODES,
  PermissionPickerDropdown,
  normalizePermissionMode,
} from '@/components/ControlBar';
import { ModelPickerDropdown } from '@/components/ModelPicker';
import { useModelCatalog, pickModelOption, reconcileLiveModelName, extraModelOptions } from '@/lib/modelCatalog';
import { MODEL_OPTIONS, EFFORT_OPTIONS, PERMISSION_OPTIONS, type DropdownOption } from '@/lib/sessionDefaultOptions';

/**
 * One status-bar readout that is also a picker: `label value` in the bar's
 * own 10px mono grammar, opening the same dropdown body the form pickers use.
 *
 * Not a fifth `variant` on EffortPicker / PermissionPicker: those own a
 * bordered Button trigger and this is a bare readout — the note on
 * EffortPicker's `inline` variant about two surfaces sharing a variant they
 * disagree about applies here too.
 */
function StatusBarPicker({
  id,
  label,
  value,
  valueClassName,
  trailing,
  title,
  content,
}: {
  id: string;
  label: string;
  value: string;
  valueClassName?: string;
  /** A second value sharing this readout — effort beside the model. */
  trailing?: React.ReactNode;
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
              'inline-flex items-center gap-1 rounded-sm px-0.5 -mx-0.5 cursor-pointer',
              'hover:bg-foreground/10 transition-colors',
              open && 'bg-foreground/10',
            )}
          >
            <span className="opacity-70">{label}</span>
            <span className={cn('truncate max-w-[9rem]', valueClassName)}>{value}</span>
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
  /** Config dir of the account the session runs under; enables the live
   *  model catalog for Claude. */
  configDir?: string;
  /** Concrete model id the live session actually runs — labels the
   *  account-default row. See SessionDefaultsRow. */
  activeDefaultModel?: string | null;
}

/** A plain option list for the engines without a stylised catalog (Codex). */
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
    <div className="w-[240px] p-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 pt-2 pb-1.5 border-b border-border/50 mb-1">
        {heading}
      </div>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => { onSelect(opt.id); }}
          title={opt.description}
          className={cn(
            'w-full flex items-start p-2.5 rounded-md text-left text-sm hover:bg-accent',
            opt.id === value && 'bg-accent',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The session's three live controls — model, effort, permission mode — as
 * status-bar readouts that open pickers. This is where they are changed; the
 * session card's summary line only reports them.
 */
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
}: SessionControlPickersProps): React.JSX.Element {
  const { models, raw } = useModelCatalog(engine === 'claude' ? configDir : undefined, activeDefaultModel);

  if (engine !== 'claude') {
    const labelOf = (opts: DropdownOption[], id: string) => opts.find((o) => o.id === id)?.label ?? id;
    return (
      <>
        <StatusBarPicker id="model" label="model" value={labelOf(MODEL_OPTIONS[engine], model)} title="Model"
          content={(close) => <OptionList heading="Model" options={MODEL_OPTIONS[engine]} value={model} onSelect={(id) => { setModel(id); close(); }} />} />
        <InlineDivider data-testid="status-divider" />
        <StatusBarPicker id="effort" label="effort" value={labelOf(EFFORT_OPTIONS[engine], effort)} title="Effort"
          content={(close) => <OptionList heading="Effort" options={EFFORT_OPTIONS[engine]} value={effort} onSelect={(id) => { setEffort(id); close(); }} />} />
        <InlineDivider data-testid="status-divider" />
        <StatusBarPicker id="perms" label="perms" value={labelOf(PERMISSION_OPTIONS[engine], permissionMode)} title="Permissions"
          content={(close) => <OptionList heading="Permissions" options={PERMISSION_OPTIONS[engine]} value={permissionMode} onSelect={(id) => { setPermissionMode(id); close(); }} />} />
      </>
    );
  }

  const modelData = pickModelOption(model, models);
  // The catalog's label is the CLI's and it lags the server — see
  // reconcileLiveModelName. The session card already reports what ran; this
  // keeps the readout beside it from saying something different.
  const modelName = reconcileLiveModelName(modelData, activeDefaultModel);
  const rawModel = raw.find((m) => m.value === model);
  const effortData = EFFORT_LEVELS.find((l) => l.id === effort);
  const effortName = effortData?.name ?? effort;
  const normalizedMode = normalizePermissionMode(permissionMode);
  const modeData = PERMISSION_MODES.find((m) => m.id === normalizedMode) ?? PERMISSION_MODES[0];

  return (
    <>
      {/* Model and effort are one control: they are picked together, and two
          separate readouts spent the bar's width on a second `effort` label
          to say one word. */}
      <StatusBarPicker
        id="model"
        label="model"
        value={modelName}
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
          />
        )}
      />
      <InlineDivider data-testid="status-divider" />
      <StatusBarPicker
        id="perms"
        label="perms"
        value={modeData.name}
        valueClassName={modeData.color}
        title={`Permissions: ${modeData.name}`}
        content={(close) => (
          <PermissionPickerDropdown
            normalizedMode={normalizedMode}
            onPermissionModeChange={setPermissionMode}
            onOpenChange={(next) => { if (!next) close(); }}
          />
        )}
      />
    </>
  );
}
