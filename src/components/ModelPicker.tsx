import React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";

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
}

export function ModelPickerDropdown({ models, selectedModel, onSelect }: ModelPickerDropdownProps) {
  return (
    <div className="w-[300px] p-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 pt-2 pb-1.5 border-b border-border/50 mb-1">
        Model
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

/**
 * Shared body for the two container-filling model triggers.
 *
 * `size` changes only the trigger's metrics. Everything else — the dropdown,
 * and crucially the apply-AND-close behaviour below — stays in one place: a
 * second hand-typed copy is exactly how the "it changes but doesn't close" bug
 * would come back on one surface and not the other.
 */
function ContainerModelPicker({
  selectedModelData,
  models,
  selectedModel,
  onSelect,
  open,
  onOpenChange,
  disabled,
  size,
}: FormModelPickerProps & { size: 'form' | 'inline' }) {
  // Apply the pick AND close the dropdown, matching EffortPicker /
  // PermissionPicker (ControlBar handleSelect). Without the close, selecting a
  // model left the popover open ("it changes but doesn't close").
  const handleSelect = (modelId: string) => {
    onSelect(modelId);
    onOpenChange(false);
  };
  const inline = size === 'inline';
  return (
    <Popover
      trigger={
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => { onOpenChange(!open); }}
          title={inline ? `Model: ${selectedModelData.name}` : undefined}
          className={cn(
            'justify-between font-normal',
            inline
              ? 'h-6 min-w-0 flex-1 gap-1 px-1.5'
              : 'w-full h-9 px-3 gap-2',
          )}
        >
          <span className={cn('flex items-center min-w-0', inline ? 'gap-1' : 'gap-2')}>
            <span className={cn("shrink-0", selectedModelData.color)}>
              {selectedModelData.icon}
            </span>
            <span className={cn('truncate', inline ? 'text-[11px]' : 'text-xs font-semibold')}>
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
    />
  );
}

/** Full-name trigger that fills its container. Used by NewSessionForm. */
export function FormModelPicker(props: FormModelPickerProps) {
  return <ContainerModelPicker {...props} size="form" />;
}

/** Dense one-line trigger for the session context popover's control row. */
export function InlineModelPicker(props: FormModelPickerProps) {
  return <ContainerModelPicker {...props} size="inline" />;
}
