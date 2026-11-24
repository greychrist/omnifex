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
  resolvedId?: string;
}

/** `[1m]` is a context opt-in on a request, not another model. */
function bareModelId(id: string): string {
  return id.replace(/\[1m\]$/, '');
}

function isRowSelected(model: Model, selected: string): boolean {
  const pick = bareModelId(selected);
  return pick === bareModelId(model.id) || (model.resolvedId !== undefined && pick === bareModelId(model.resolvedId));
}

function modelIconStyle(model: Model): React.CSSProperties | undefined {
  const color = modelOwnColor(model.resolvedId ?? model.id, screenChartMode());
  return color ? { color } : undefined;
}

interface ModelPickerDropdownProps {
  models: Model[];
  selectedModel: string;
  onSelect: (modelId: string) => void;
  effort?: string;
  onEffortSelect?: (level: EffortLevel) => void;
  effortLevels?: EffortLevel[];
  extras?: Model[];
  onRefresh?: () => void;
  refreshing?: boolean;
}

// Panels swap in place, not nested popovers: Popover portals to body, so pressing an inner one closes the outer.
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
  // Close on pick too, or the popover stays open after selecting.
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
