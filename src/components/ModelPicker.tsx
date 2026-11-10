import React, { useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, FIELD_TRIGGER } from "@/components/ui/popover";
import { ACCOUNT_DEFAULT_MARK, splitLatestModels } from "@/lib/modelCatalog";
import { modelOwnColor, screenChartMode } from "@/lib/costChartPalette";
import { EFFORT_LEVELS, EffortPickerDropdown, type EffortLevel } from "@/components/ControlBar";
import { POPOVER_SECTION, POPOVER_OPTION_DETAIL, POPOVER_RULE, popoverOption } from "@/components/ui/popover-list";

export interface Model {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  shortName: string;
  /** The concrete model this row stands for when `id` is not one: the CLI's
   *  mapping of an alias (`opus[1m]` → `claude-opus-5-5[1m]`), or the model
   *  behind the merged account-default row. Highlights that row when the
   *  pick is this model, and gives it that model's colour. */
  resolvedId?: string;
}

/** `[1m]` is a context opt-in on a request, not another model. */
function bareModelId(id: string): string {
  return id.replace(/\[1m\]$/, '');
}

/** Whether `selected` is this row: its id, or the model it stands for. */
function isRowSelected(model: Model, selected: string): boolean {
  const pick = bareModelId(selected);
  return pick === bareModelId(model.id) || (model.resolvedId !== undefined && pick === bareModelId(model.resolvedId));
}

/** The Cost Report's colour for the row's model — its price tier, its
 *  version's shade — so a model looks the same here as in the chart and on
 *  a Modern model-change line. None for a row with no tier ("default"). */
function modelIconStyle(model: Model): React.CSSProperties | undefined {
  const color = modelOwnColor(model.resolvedId ?? model.id, screenChartMode());
  return color ? { color } : undefined;
}

// The model list is dynamic — sourced from the CLI catalog via
// src/lib/modelCatalog.tsx (live session init data or the per-account
// cached lookup). The static fallback lives there too (FALLBACK_MODELS).

// ---------------------------------------------------------------------------
// ModelPickerDropdown — the popup content shared by compact and expanded modes
// ---------------------------------------------------------------------------

interface ModelPickerDropdownProps {
  models: Model[];
  selectedModel: string;
  onSelect: (modelId: string) => void;
  /** Current effort. Supply with `onEffortSelect` to put effort in this
   *  dropdown instead of a readout of its own. */
  effort?: string;
  onEffortSelect?: (level: EffortLevel) => void;
  /** Effort levels this model supports, from the CLI catalog. */
  effortLevels?: EffortLevel[];
  /** Models the account's catalog does not list but the CLI will accept —
   *  see `extraModelOptions`. Behind the "More models" row with the catalog's
   *  older versions (splitLatestModels): they are the escape hatch, not the
   *  normal choice. */
  extras?: Model[];
  /** Re-read the account's catalog from the CLI (useModelCatalog.refresh).
   *  Omitted → no Refresh row. */
  onRefresh?: () => void;
  refreshing?: boolean;
}

/**
 * Panels swap IN PLACE rather than opening nested popovers. A popover inside
 * a popover inside the status bar is three stacked dismiss layers, and the
 * custom Popover portals to body (see the `data-omnifex-popover` note in
 * Popover) — the outer one closes when the inner one is pressed. One panel
 * with a back row has neither problem and is testable without layout.
 */
type Panel = 'models' | 'effort' | 'more';

export function ModelPickerDropdown({
  models,
  selectedModel,
  onSelect,
  effort,
  onEffortSelect,
  effortLevels,
  extras,
  onRefresh,
  refreshing,
}: ModelPickerDropdownProps) {
  const [panel, setPanel] = useState<Panel>('models');
  const showEffort = effort !== undefined && onEffortSelect !== undefined;
  // Older versions of a family the catalog does list come first under More;
  // the uncatalogued extras are the further-out escape hatch.
  const { latest, older } = splitLatestModels(models);
  const more = [...older, ...(extras ?? [])];
  const showMore = more.length > 0;

  if (panel === 'effort' && showEffort) {
    return (
      <div className="w-72 flex flex-col gap-0.5">
        <PanelHeader title="Effort" onBack={() => { setPanel('models'); }} />
        <EffortPickerDropdown
          effort={effort as EffortLevel}
          levels={effortLevels}
          onSelect={(level) => { onEffortSelect(level); setPanel('models'); }}
          bare
        />
      </div>
    );
  }

  if (panel === 'more' && showMore) {
    return (
      <div className="w-72 flex flex-col gap-0.5">
        <PanelHeader title="More models" onBack={() => { setPanel('models'); }} />
        {more.map((model) => (
          <button
            key={model.id}
            onClick={() => { onSelect(model.id); }}
            className={popoverOption(isRowSelected(model, selectedModel))}
          >
            <span className="font-medium">{model.name}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <ModelList
      models={latest}
      selectedModel={selectedModel}
      onSelect={onSelect}
      effortName={showEffort ? (EFFORT_LEVELS.find((l) => l.id === effort)?.name ?? effort) : null}
      onOpenEffort={showEffort ? () => { setPanel('effort'); } : null}
      onOpenMore={showMore ? () => { setPanel('more'); } : null}
      onRefresh={onRefresh ?? null}
      refreshing={refreshing ?? false}
    />
  );
}

/** Back row + title, shared by the two secondary panels. */
function PanelHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Back to models (${title})`}
      onClick={onBack}
      className={cn(POPOVER_SECTION, "mb-1 flex items-center gap-1 text-left hover:text-foreground transition-colors")}
    >
      <ChevronLeft className="h-3 w-3" />
      <span>{title}</span>
    </button>
  );
}

/** A row that opens a secondary panel: `label … value ›`. */
function PanelLink({ label, value, onClick }: { label: string; value?: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn(popoverOption(false), "items-center justify-between")}>
      <span className="font-medium">{label}</span>
      <span className="flex items-center gap-1 text-muted-foreground">
        {value}
        <ChevronRight className="h-3 w-3" />
      </span>
    </button>
  );
}

function ModelList({
  models,
  selectedModel,
  onSelect,
  effortName,
  onOpenEffort,
  onOpenMore,
  onRefresh,
  refreshing,
}: {
  models: Model[];
  selectedModel: string;
  onSelect: (modelId: string) => void;
  effortName: string | null;
  onOpenEffort: (() => void) | null;
  onOpenMore: (() => void) | null;
  onRefresh: (() => void) | null;
  refreshing: boolean;
}) {
  // The account-default model is marked in place rather than listed twice, so
  // the header carries the key for the mark (see withAccountDefaultLabel).
  const marked = models.some((m) => m.name.endsWith(ACCOUNT_DEFAULT_MARK));
  return (
    <div className="w-72 flex flex-col gap-0.5">
      <div className={cn(POPOVER_SECTION, "mb-1 flex items-baseline justify-between gap-2")}>
        <span>Model</span>
        {marked && (
          <span className="normal-case tracking-normal">
            {ACCOUNT_DEFAULT_MARK} account default
          </span>
        )}
      </div>
      {models.map((model) => (
        <button
          key={model.id}
          onClick={() => { onSelect(model.id); }}
          className={popoverOption(isRowSelected(model, selectedModel))}
        >
          <span className="mt-px shrink-0" style={modelIconStyle(model)}>
            {model.icon}
          </span>
          <div className="flex-1 min-w-0">
            <div className="font-medium">{model.name}</div>
            <div className={POPOVER_OPTION_DETAIL}>
              {model.description}
            </div>
          </div>
        </button>
      ))}
      {(onOpenEffort || onOpenMore || onRefresh) && <div className={cn(POPOVER_RULE, "my-1")} />}
      {onOpenEffort && <PanelLink label="Effort" value={effortName} onClick={onOpenEffort} />}
      {onOpenMore && <PanelLink label="More models" onClick={onOpenMore} />}
      {onRefresh && (
        // The catalog is cached per account and only refetched on a CLI
        // update or after a day; a model granted in between needs this.
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className={cn(popoverOption(false), "items-center gap-2 text-muted-foreground disabled:opacity-60")}
        >
          <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
          <span>{refreshing ? "Refreshing models…" : "Refresh models"}</span>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FormModelPicker — full-name trigger that fills its container.
// Used by NewSessionForm. Same dropdown content as the others.
// ---------------------------------------------------------------------------

interface FormModelPickerProps {
  selectedModelData: Model;
  models: Model[];
  selectedModel: string;
  onSelect: (modelId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
}

/** Full-name trigger that fills its container. Used by NewSessionForm and
 *  the account dialog's defaults row. */
export function FormModelPicker({
  selectedModelData,
  models,
  selectedModel,
  onSelect,
  open,
  onOpenChange,
  disabled,
  onRefresh,
  refreshing,
}: FormModelPickerProps) {
  // Apply the pick AND close the dropdown, matching EffortPicker /
  // PermissionPicker (ControlBar handleSelect). Without the close, selecting a
  // model left the popover open ("it changes but doesn't close").
  const handleSelect = (modelId: string) => {
    onSelect(modelId);
    onOpenChange(false);
  };
  return (
    <Popover
      trigger={
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => { onOpenChange(!open); }}
          className="justify-between font-normal w-full min-w-0 h-9 px-3 gap-2"
        >
          <span className="flex items-center min-w-0 gap-2">
            <span className="shrink-0" style={modelIconStyle(selectedModelData)}>
              {selectedModelData.icon}
            </span>
            <span className="truncate text-xs font-semibold">
              {selectedModelData.name}
            </span>
          </span>
          <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
        </Button>
      }
      content={
        <ModelPickerDropdown
          models={models}
          selectedModel={selectedModel}
          onSelect={handleSelect}
          onRefresh={onRefresh}
          refreshing={refreshing}
        />
      }
      open={open}
      onOpenChange={onOpenChange}
      align="start"
      side="bottom"
      triggerClassName={FIELD_TRIGGER}
    />
  );
}
