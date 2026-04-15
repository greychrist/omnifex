import React from "react";
import { Zap, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip-modern";
import { motion } from "framer-motion";
import { type SessionModelInfo } from "@/lib/api";

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
    name: "Claude Opus 4.6 (1M)",
    description: "Most capable, 1M context window",
    icon: <Zap className="h-3.5 w-3.5" />,
    shortName: "O",
    color: "text-primary"
  },
  {
    id: "opus",
    name: "Claude Opus 4.6 (200K)",
    description: "Most capable, standard context",
    icon: <Zap className="h-3.5 w-3.5" />,
    shortName: "O",
    color: "text-primary"
  },
  {
    id: "sonnet",
    name: "Claude Sonnet 4.6",
    description: "Faster, efficient for most tasks",
    icon: <Zap className="h-3.5 w-3.5" />,
    shortName: "S",
    color: "text-primary"
  }
];

// Derive a short 1-2 letter badge from a model display name so the compact
// picker trigger still renders a shortName when the parent hands us a live
// model list without shortNames.
export function shortNameFor(displayName: string): string {
  const cleaned = displayName
    .replace(/claude\s*/i, "")
    .replace(/\(.*?\)/g, "")
    .trim();
  const firstWord = cleaned.split(/[\s\-]+/)[0] || "";
  return firstWord.slice(0, 1).toUpperCase() || "?";
}

/** Build the effective model list from live SDK data or the hardcoded fallback. */
export function buildEffectiveModels(supportedModels?: SessionModelInfo[]): Model[] {
  if (supportedModels && supportedModels.length > 0) {
    return supportedModels.map<Model>((m) => ({
      id: m.value,
      name: m.displayName,
      description: m.description,
      icon: <Zap className="h-3.5 w-3.5" />,
      shortName: shortNameFor(m.displayName),
      color: "text-primary",
    }));
  }
  return MODELS;
}

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
                className="h-9 px-2 hover:bg-accent/50 gap-1"
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
