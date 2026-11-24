import React from "react";
import {
  ChevronUp,
  ChevronDown,
  Shield,
  ShieldOff,
  ShieldX,
  FilePen,
  ClipboardList,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, FIELD_TRIGGER } from "@/components/ui/popover";
import { POPOVER_SECTION, POPOVER_OPTION_DETAIL, popoverOption } from "@/components/ui/popover-list";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip-modern";
import { motion } from "framer-motion";
import type { SessionModelInfo } from "@/lib/api";
import { ACCOUNT_DEFAULT_MARK } from "@/lib/modelCatalog";

// `auto` = omit `--effort` / send `effortLevel: null`; the default is per-model, so no fixed level can stand in.
// Accepted levels come from the catalog's `supportedEffortLevels`: keep descriptions free of model names (pinned in tests).
export type EffortLevel = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: { id: EffortLevel; name: string; description: string; shortName: string; color: string }[] = [
  { id: 'auto', name: 'Auto', description: "The model's own default level", shortName: 'Auto', color: 'text-muted-foreground' },
  { id: 'low', name: 'Low', description: 'Fastest and cheapest; thinks only when it has to', shortName: 'Lo', color: 'text-blue-600' },
  { id: 'medium', name: 'Medium', description: 'Balances speed and depth', shortName: 'Med', color: 'text-green-600' },
  { id: 'high', name: 'High', description: 'Spends what the task needs', shortName: 'Hi', color: 'text-yellow-600' },
  { id: 'xhigh', name: 'Extra High', description: 'For long-running agentic and coding work', shortName: 'Xhi', color: 'text-orange-600' },
  { id: 'max', name: 'Max', description: 'No cap on token spend', shortName: 'Max', color: 'text-red-600' },
];

/** `undefined` = not catalogued (show all); `[]` = no effort support (Auto only). */
export function catalogEffortLevels(model: SessionModelInfo | undefined): EffortLevel[] | undefined {
  if (!model) return undefined;
  return model.supportedEffortLevels ?? [];
}

export function visibleEffortLevels(levels: EffortLevel[] | undefined): typeof EFFORT_LEVELS {
  return levels ? EFFORT_LEVELS.filter((l) => l.id === 'auto' || levels.includes(l.id)) : EFFORT_LEVELS;
}


export interface PermissionMode {
  id: string;
  name: string;
  description: string;
  shortName: string;
  icon: React.ReactNode;
  color: string;
}

// UI order (least to most permissive), not the CLI enum order.
export const PERMISSION_MODES: PermissionMode[] = [
  {
    id: "default",
    name: "Default",
    description:
      "Prompt when hooks/settings rules do not already allow or deny.",
    shortName: "DEF",
    icon: <Shield className="h-3.5 w-3.5" />,
    color: "text-green-600",
  },
  {
    id: "acceptEdits",
    name: "Accept Edits",
    description:
      "Auto-approve file edits and common filesystem operations; prompt for other unmatched tools.",
    shortName: "EDIT",
    icon: <FilePen className="h-3.5 w-3.5" />,
    color: "text-purple-600",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Plan only; no tool execution.",
    shortName: "PLAN",
    icon: <ClipboardList className="h-3.5 w-3.5" />,
    color: "text-teal-600",
  },
  {
    id: "dontAsk",
    name: "No Prompts",
    description: "Run only pre-approved tools; deny everything else.",
    shortName: "DENY",
    icon: <ShieldX className="h-3.5 w-3.5" />,
    color: "text-slate-600",
  },
  {
    id: "auto",
    name: "Auto Review",
    description:
      "Use Claude Code's safety check to approve or deny unmatched tool requests.",
    shortName: "AUTO",
    icon: <Sparkles className="h-3.5 w-3.5" />,
    color: "text-yellow-600",
  },
  {
    id: "bypassPermissions",
    name: "Bypass",
    description:
      "Skip permission prompts for all tools. Dangerous; hooks may still block.",
    shortName: "ALL",
    icon: <ShieldOff className="h-3.5 w-3.5" />,
    color: "text-red-600",
  },
];

// "skip" is a legacy alias for bypassPermissions.
export function normalizePermissionMode(mode: string): string {
  if (mode === "skip") return "bypassPermissions";
  return mode;
}

interface EffortPickerProps {
  effort: EffortLevel;
  onEffortChange?: (level: EffortLevel) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  variant?: "compact" | "expanded" | "form";
  levels?: EffortLevel[];
}

export function EffortPickerDropdown({ effort, onSelect, levels, bare = false }: { effort: EffortLevel; onSelect: (level: EffortLevel) => void; levels?: EffortLevel[]; bare?: boolean }) {
  const visible = visibleEffortLevels(levels);
  return (
    <div className={cn("flex flex-col gap-0.5", !bare && "w-72")}>
      {!bare && <div className={cn(POPOVER_SECTION, "mb-1")}>Effort</div>}
      {visible.map((level) => (
        <button
          key={level.id}
          onClick={() => { onSelect(level.id); }}
          className={popoverOption(effort === level.id)}
        >
          <span className={cn("w-9 shrink-0 font-bold", level.color)}>
            {level.shortName}
          </span>
          <div className="flex-1 min-w-0">
            <div className="font-medium">{level.name}</div>
            <div className={POPOVER_OPTION_DETAIL}>{level.description}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

export function EffortPicker({ effort, onEffortChange, open, onOpenChange, disabled, variant = "compact", levels }: EffortPickerProps) {
  const currentLevel = EFFORT_LEVELS.find(e => e.id === effort);

  const handleSelect = (level: EffortLevel) => {
    onEffortChange?.(level);
    onOpenChange(false);
  };

  if (variant === "expanded") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Effort:</span>
        <Popover
          trigger={
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { onOpenChange(!open); }}
                  className="gap-1"
                >
                  <span className={cn("text-xs font-semibold", currentLevel?.color)}>
                    {currentLevel?.shortName}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">Effort: {currentLevel?.name}</p>
                <p className="text-xs text-muted-foreground">{currentLevel?.description}</p>
              </TooltipContent>
            </Tooltip>
          }
          content={<EffortPickerDropdown effort={effort} onSelect={handleSelect} levels={levels} />}
          open={open}
          onOpenChange={onOpenChange}
          align="start"
          side="top"
        />
      </div>
    );
  }

  if (variant === "form") {
    return (
      <Popover
        trigger={
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => { onOpenChange(!open); }}
            className="w-full justify-between h-9 px-3 font-normal"
          >
            <span className={cn("text-xs font-semibold", currentLevel?.color)}>
              {currentLevel?.name}
            </span>
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        }
        content={<EffortPickerDropdown effort={effort} onSelect={handleSelect} levels={levels} />}
        open={open}
        onOpenChange={onOpenChange}
        align="start"
        side="bottom"
        triggerClassName={FIELD_TRIGGER}
      />
    );
  }

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
                <span className={cn("text-[10px] font-bold", currentLevel?.color)}>
                  {currentLevel?.shortName}
                </span>
                <ChevronUp className="h-3 w-3 ml-0.5 opacity-70" />
              </Button>
            </motion.div>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs font-medium">Effort: {currentLevel?.name}</p>
            <p className="text-xs text-muted-foreground">{currentLevel?.description}</p>
          </TooltipContent>
        </Tooltip>
      }
      content={<EffortPickerDropdown effort={effort} onSelect={handleSelect} levels={levels} />}
      open={open}
      onOpenChange={onOpenChange}
      align="start"
      side="top"
    />
  );
}

interface PermissionPickerProps {
  permissionMode: string;
  onPermissionModeChange?: (mode: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  variant?: "compact" | "form";
}

// Shared by every trigger: a second copy drifts on the six modes or on closing after a pick.
export function PermissionPickerDropdown({
  normalizedMode,
  onPermissionModeChange,
  onOpenChange,
  onRestartInBypass,
  defaultMode,
}: {
  normalizedMode: string;
  onPermissionModeChange?: (mode: string) => void;
  onOpenChange: (open: boolean) => void;
  defaultMode?: string | null;
  /** Set when not launched in Bypass: the CLI refuses a mid-session switch to it. */
  onRestartInBypass?: () => void;
}) {
  return (
    <div className="w-72 flex flex-col gap-0.5">
      <div className={cn(POPOVER_SECTION, "mb-1 flex items-baseline justify-between gap-2")}>
        <span>Permissions</span>
        {defaultMode && PERMISSION_MODES.some((m) => m.id === defaultMode) && (
          <span className="normal-case tracking-normal">
            {ACCOUNT_DEFAULT_MARK} account default
          </span>
        )}
      </div>
      {PERMISSION_MODES.map((mode) => {
        const isActive = mode.id === normalizedMode;
        const name = mode.id === defaultMode ? `${mode.name} ${ACCOUNT_DEFAULT_MARK}` : mode.name;
        if (mode.id === "bypassPermissions" && onRestartInBypass) {
          return (
            <div
              key={mode.id}
              aria-disabled="true"
              className={cn(popoverOption(false), "hover:bg-transparent")}
            >
              <span className={cn("mt-px shrink-0 opacity-50", mode.color)}>
                {mode.icon}
              </span>
              <div className="flex-1 min-w-0">
                <div className={cn("font-medium opacity-50", mode.color)}>
                  {name}
                </div>
                <div className={POPOVER_OPTION_DETAIL}>
                  Only available in a session started in Bypass.
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1.5 h-6 px-2 text-[11px]"
                  onClick={() => {
                    onRestartInBypass();
                    onOpenChange(false);
                  }}
                >
                  Restart in Bypass
                </Button>
              </div>
            </div>
          );
        }
        return (
          <button
            key={mode.id}
            onClick={() => {
              onPermissionModeChange?.(mode.id);
              onOpenChange(false);
            }}
            className={popoverOption(isActive)}
          >
            <span className={cn("mt-px shrink-0", mode.color)}>
              {mode.icon}
            </span>
            <div className="flex-1 min-w-0">
              <div className={cn("font-medium", mode.color)}>
                {name}
              </div>
              <div className={POPOVER_OPTION_DETAIL}>
                {mode.description}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function PermissionPicker({ permissionMode, onPermissionModeChange, open, onOpenChange, disabled, variant = "compact" }: PermissionPickerProps) {
  const normalizedMode = normalizePermissionMode(permissionMode);
  const selectedData = PERMISSION_MODES.find((m) => m.id === normalizedMode) || PERMISSION_MODES[0];
  const isFormVariant = variant === "form";

  return (
    <Popover
      trigger={
        isFormVariant ? (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => { onOpenChange(!open); }}
            className="w-full justify-between h-9 px-3 font-normal gap-2"
          >
            <span className="flex items-center gap-2 min-w-0">
              <span className={cn("shrink-0", selectedData.color)}>
                {selectedData.icon}
              </span>
              <span className={cn("text-xs font-semibold truncate", selectedData.color)}>
                {selectedData.name}
              </span>
            </span>
            <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
          </Button>
        ) : (
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
                className={cn(
                  "h-9 px-2 bg-background hover:bg-accent/50 gap-1 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent)]",
                  selectedData.color,
                )}
              >
                {selectedData.icon}
                <span className="text-[10px] font-bold">
                  {selectedData.shortName}
                </span>
                <ChevronUp className="h-3 w-3 ml-0.5 opacity-70" />
              </Button>
            </motion.div>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs font-medium">
              Permissions: {selectedData.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {selectedData.description}
            </p>
          </TooltipContent>
        </Tooltip>
        )
      }
      content={<PermissionPickerDropdown
        normalizedMode={normalizedMode}
        onPermissionModeChange={onPermissionModeChange}
        onOpenChange={onOpenChange}
      />}
      open={open}
      onOpenChange={onOpenChange}
      align="start"
      side={isFormVariant ? "bottom" : "top"}
      {...(isFormVariant ? { triggerClassName: FIELD_TRIGGER } : {})}
    />
  );
}
