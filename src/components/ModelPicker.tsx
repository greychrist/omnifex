import React from "react";
import { Zap, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip-modern";
import { motion } from "framer-motion";

export type Model = {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  shortName: string;
  color: string;
};

export const MODELS: Model[] = [
  {
    id: "opus[1m]",
    name: "Opus 4.7 (1M)",
    description: "Most capable, 1M context window",
    icon: <Zap className="h-3.5 w-3.5" />,
    shortName: "O",
    color: "text-primary"
  },
  {
    id: "opus",
    name: "Opus 4.7 (200K)",
    description: "Most capable, standard context",
    icon: <Zap className="h-3.5 w-3.5" />,
    shortName: "O",
    color: "text-primary"
  },
  {
    id: "sonnet",
    name: "Sonnet 4.6",
    description: "Faster, efficient for most tasks",
    icon: <Zap className="h-3.5 w-3.5" />,
    shortName: "S",
    color: "text-primary"
  },
  {
    id: "haiku",
    name: "Haiku 4.5",
    description: "Fastest and cheapest, good for simple tasks",
    icon: <Zap className="h-3.5 w-3.5" />,
    shortName: "H",
    color: "text-primary"
  }
];

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
          onClick={() => onSelect(model.id)}
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
// CompactModelPicker — the compact trigger+popover used in the bottom bar
// ---------------------------------------------------------------------------

interface CompactModelPickerProps {
  selectedModelData: Model;
  models: Model[];
  selectedModel: string;
  onSelect: (modelId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}

export function CompactModelPicker({
  selectedModelData,
  models,
  selectedModel,
  onSelect,
  open,
  onOpenChange,
  disabled,
}: CompactModelPickerProps) {
  return (
    <Popover
      trigger={
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.div
              whileTap={{ scale: 0.97 }}
              transition={{ duration: 0.15 }}
            >
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                className="h-9 px-2 bg-background hover:bg-accent/50 gap-1 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent)]"
              >
                <span className={selectedModelData.color}>
                  {selectedModelData.icon}
                </span>
                <span className="text-[10px] font-bold opacity-70">
                  {selectedModelData.shortName}
                </span>
                <ChevronUp className="h-3 w-3 ml-0.5 opacity-50" />
              </Button>
            </motion.div>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs font-medium">{selectedModelData.name}</p>
            <p className="text-xs text-muted-foreground">{selectedModelData.description}</p>
          </TooltipContent>
        </Tooltip>
      }
      content={
        <ModelPickerDropdown
          models={models}
          selectedModel={selectedModel}
          onSelect={onSelect}
        />
      }
      open={open}
      onOpenChange={onOpenChange}
      align="start"
      side="top"
    />
  );
}

// ---------------------------------------------------------------------------
// ExpandedModelPicker — the labeled trigger+popover used in the expanded modal
// ---------------------------------------------------------------------------

interface ExpandedModelPickerProps {
  selectedModelData: Model;
  models: Model[];
  selectedModel: string;
  onSelect: (modelId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExpandedModelPicker({
  selectedModelData,
  models,
  selectedModel,
  onSelect,
  open,
  onOpenChange,
}: ExpandedModelPickerProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Model:</span>
      <Popover
        trigger={
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(!open)}
            className="gap-2"
          >
            <span className={selectedModelData.color}>
              {selectedModelData.icon}
            </span>
            {selectedModelData.name}
          </Button>
        }
        content={
          <ModelPickerDropdown
            models={models}
            selectedModel={selectedModel}
            onSelect={onSelect}
          />
        }
        open={open}
        onOpenChange={onOpenChange}
        align="start"
        side="top"
      />
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

export function FormModelPicker({
  selectedModelData,
  models,
  selectedModel,
  onSelect,
  open,
  onOpenChange,
  disabled,
}: FormModelPickerProps) {
  return (
    <Popover
      trigger={
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onOpenChange(!open)}
          className="w-full justify-between h-9 px-3 font-normal gap-2"
        >
          <span className="flex items-center gap-2 min-w-0">
            <span className={cn("shrink-0", selectedModelData.color)}>
              {selectedModelData.icon}
            </span>
            <span className="text-xs font-semibold truncate">
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
          onSelect={onSelect}
        />
      }
      open={open}
      onOpenChange={onOpenChange}
      align="start"
      side="bottom"
    />
  );
}
