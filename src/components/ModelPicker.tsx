import React, { useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, FIELD_TRIGGER } from "@/components/ui/popover";
import { ACCOUNT_DEFAULT_MARK, splitLatestModels } from "@/lib/modelCatalog";
import { EFFORT_LEVELS, EffortPickerDropdown, type EffortLevel } from "@/components/ControlBar";

export interface Model {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  shortName: string;
  color: string;
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
      <div className="w-[300px] p-1">
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
      <div className="w-[300px] p-1">
        <PanelHeader title="More models" onBack={() => { setPanel('models'); }} />
        {more.map((model) => (
          <button
            key={model.id}
            onClick={() => { onSelect(model.id); }}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-left',
              'hover:bg-accent',
              selectedModel === model.id && 'bg-accent',
            )}
          >
            <span className="font-medium text-sm">{model.name}</span>
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
      className="w-full flex items-center gap-1.5 px-3 pt-2 pb-1.5 mb-1 border-b border-border/50 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
    >
      <ChevronLeft className="h-3 w-3" />
      <span>{title}</span>
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
}: {
  models: Model[];
  selectedModel: string;
  onSelect: (modelId: string) => void;
  effortName: string | null;
  onOpenEffort: (() => void) | null;
  onOpenMore: (() => void) | null;
}) {
  // The account-default model is marked in place rather than listed twice, so
  // the header carries the key for the mark (see withAccountDefaultLabel).
  const marked = models.some((m) => m.name.endsWith(ACCOUNT_DEFAULT_MARK));
  return (
    <div className="w-[300px] p-1">
      <div className="flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-wider text-muted-foreground px-3 pt-2 pb-1.5 border-b border-border/50 mb-1">
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
          className={cn(
            "w-full flex items-start gap-3 p-3 rounded-md transition-colors text-left",
            "hover:bg-accent",
            selectedModel === model.id && "bg-accent"
          )}
        >
          <div className="mt-0.5">
            <span className={model.color}>
              {model.icon}
            </span>
          </div>
          <div className="flex-1 space-y-1">
            <div className="font-medium text-sm">{model.name}</div>
            <div className="text-xs text-muted-foreground">
              {model.description}
            </div>
          </div>
        </button>
      ))}
      {onOpenEffort && (
        <>
          <div className="my-1 border-t border-border/50" />
          <button
            type="button"
            onClick={onOpenEffort}
            className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md hover:bg-accent transition-colors text-left"
          >
            <span className="font-medium text-sm">Effort</span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {effortName}
              <ChevronRight className="h-3 w-3" />
            </span>
          </button>
        </>
      )}
      {onOpenMore && (
        <>
          <div className="my-1 border-t border-border/50" />
          <button
            type="button"
            onClick={onOpenMore}
            className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md hover:bg-accent transition-colors text-left"
          >
            <span className="font-medium text-sm">More models</span>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          </button>
        </>
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
            <span className={cn("shrink-0", selectedModelData.color)}>
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
