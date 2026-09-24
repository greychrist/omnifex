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
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip-modern";
import { motion } from "framer-motion";
import type { SessionModelInfo } from "@/lib/api";

// ── Effort ──────────────────────────────────────────────────────────────

/**
 * Effort level — the CLI's `--effort` / `effortLevel` (`low | medium | high |
 * xhigh | max`), plus `auto`: send no level and let the CLI pick the model's
 * own default. That default is decided per model at runtime — org setting,
 * server flag, settings.json, then the model's capability, then `high` — and
 * differs between models (Opus 5.5 is `medium`), so no fixed level can stand
 * in for it. `auto` never reaches the CLI as a value: the engine omits
 * `--effort` and a mid-session change sends `effortLevel: null`.
 *
 * Which levels a model accepts comes from the CLI catalog's
 * `supportedEffortLevels`, never from these descriptions — keep them free of
 * model names, versions and "default" claims (pinned in ControlBar.test.tsx).
 *
 * @see https://platform.claude.com/docs/en/build-with-claude/effort
 */
export type EffortLevel = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: { id: EffortLevel; name: string; description: string; shortName: string; color: string }[] = [
  { id: 'auto', name: 'Auto', description: "The model's own default level", shortName: 'Auto', color: 'text-muted-foreground' },
  { id: 'low', name: 'Low', description: 'Fastest and cheapest; thinks only when it has to', shortName: 'Lo', color: 'text-blue-600' },
  { id: 'medium', name: 'Medium', description: 'Balances speed and depth', shortName: 'Med', color: 'text-green-600' },
  { id: 'high', name: 'High', description: 'Spends what the task needs', shortName: 'Hi', color: 'text-yellow-600' },
  { id: 'xhigh', name: 'Extra High', description: 'For long-running agentic and coding work', shortName: 'Xhi', color: 'text-orange-600' },
  { id: 'max', name: 'Max', description: 'No cap on token spend', shortName: 'Max', color: 'text-red-600' },
];

/**
 * The levels a catalogued model accepts. `undefined` means the model is not
 * in the catalog (no data — show everything); a catalogued model without
 * effort support (Haiku) gets `[]`, which leaves only Auto.
 */
export function catalogEffortLevels(model: SessionModelInfo | undefined): EffortLevel[] | undefined {
  if (!model) return undefined;
  return model.supportedEffortLevels ?? [];
}

/** Picker rows for a model's `levels`. Auto is always offered. */
export function visibleEffortLevels(levels: EffortLevel[] | undefined): typeof EFFORT_LEVELS {
  return levels ? EFFORT_LEVELS.filter((l) => l.id === 'auto' || levels.includes(l.id)) : EFFORT_LEVELS;
}


// ── Permission ──────────────────────────────────────────────────────────

export interface PermissionMode {
  id: string;
  name: string;
  description: string;
  shortName: string;
  /** Lucide icon node */
  icon: React.ReactNode;
  /** Tailwind text color for the trigger and legend swatch */
  color: string;
}

// Mirrors the CLI's PermissionMode union exactly:
//   'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
// Order is UI ordering (least to most permissive-ish), not CLI enum order.
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
    // Matches Claude Code's accept-edits indicator (purple).
    color: "text-purple-600",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Plan only; no tool execution.",
    shortName: "PLAN",
    icon: <ClipboardList className="h-3.5 w-3.5" />,
    // Matches Claude Code's plan-mode indicator (blue-green / teal).
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
    // Matches Claude Code's auto/safety-review indicator (yellow).
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

// Back-compat: the pre-session panel and some older callers use "skip" as
// a binary alias for bypassPermissions. Map it on read so we don't break
// anything while the rest of the app migrates to full CLI modes.
export function normalizePermissionMode(mode: string): string {
  if (mode === "skip") return "bypassPermissions";
  return mode;
}

// ── Effort Picker ───────────────────────────────────────────────────────

interface EffortPickerProps {
  effort: EffortLevel;
  onEffortChange?: (level: EffortLevel) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  /** "compact" (bottom bar), "expanded" (modal), "form" (full-name
   *  trigger that fills its container — used in NewSessionForm). */
  variant?: "compact" | "expanded" | "form";
  /**
   * Levels the selected model actually supports — see `catalogEffortLevels`.
   * Omitted/undefined shows every level, the fallback when no catalog data
   * exists for the selection. Auto is shown either way.
   */
  levels?: EffortLevel[];
}

export function EffortPickerDropdown({ effort, onSelect, levels, bare = false }: { effort: EffortLevel; onSelect: (level: EffortLevel) => void; levels?: EffortLevel[]; bare?: boolean }) {
  const visible = visibleEffortLevels(levels);
  // `bare` drops the frame and heading so the model dropdown can host this
  // list under its own back header — one panel, not a box inside a box.
  return (
    <div className={bare ? undefined : "w-[280px] p-1"}>
      {!bare && (
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 pt-2 pb-1.5 border-b border-border/50 mb-1">
          Effort
        </div>
      )}
      {visible.map((level) => (
        <button
          key={level.id}
          onClick={() => { onSelect(level.id); }}
          className={cn(
            "w-full flex items-start gap-3 p-3 rounded-md transition-colors text-left",
            "hover:bg-accent",
            effort === level.id && "bg-accent"
          )}
        >
          <span className={cn("text-sm font-bold mt-0.5", level.color)}>
            {level.shortName}
          </span>
          <div className="flex-1 space-y-1">
            <div className="font-medium text-sm">{level.name}</div>
            <div className="text-xs text-muted-foreground">{level.description}</div>
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

// ── Permission Picker ───────────────────────────────────────────────────

interface PermissionPickerProps {
  permissionMode: string;
  onPermissionModeChange?: (mode: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  /** "compact" (bottom bar) or "form" (full-name trigger that fills its
   *  container — used in NewSessionForm). Defaults to "compact". */
  variant?: "compact" | "form";
}

/**
 * The permission dropdown body, shared by every trigger (including the
 * status bar's `SessionControlPickers`): a second hand-typed copy would drift
 * on the option set (all six CLI modes) or on closing after a pick.
 */
export function PermissionPickerDropdown({
  normalizedMode,
  onPermissionModeChange,
  onOpenChange,
}: {
  normalizedMode: string;
  onPermissionModeChange?: (mode: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <div className="w-[300px] p-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 pt-2 pb-1.5 border-b border-border/50 mb-1">
        Permissions
      </div>
      {PERMISSION_MODES.map((mode) => {
        const isActive = mode.id === normalizedMode;
        return (
          <button
            key={mode.id}
            onClick={() => {
              onPermissionModeChange?.(mode.id);
              onOpenChange(false);
            }}
            className={cn(
              "w-full flex items-start gap-3 p-3 rounded-md transition-colors text-left",
              "hover:bg-accent",
              isActive && "bg-accent",
            )}
          >
            <span className={cn("mt-0.5", mode.color)}>
              {mode.icon}
            </span>
            <div className="flex-1 space-y-1">
              <div className={cn("font-medium text-sm", mode.color)}>
                {mode.name}
              </div>
              <div className="text-xs text-muted-foreground">
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
