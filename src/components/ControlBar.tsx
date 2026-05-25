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
  Brain,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip-modern";
import { motion } from "framer-motion";

// ── Effort ──────────────────────────────────────────────────────────────

/**
 * Effort level — maps to the SDK's reasoning_effort parameter.
 *
 * Mirrors the SDK's `EffortLevel` type exactly (`low | medium | high | xhigh | max`).
 * No `auto` — the SDK has no `'auto'` value, so it was a renderer-only sentinel
 * that meant "don't set effort, let the SDK default (high) apply." Removed
 * 2026-04-16 in favor of an explicit default of `high`.
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/effort
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: { id: EffortLevel; name: string; description: string; shortName: string; color: string }[] = [
  { id: 'low', name: 'Low', description: 'Minimal thinking, fastest responses', shortName: 'Lo', color: 'text-blue-600' },
  { id: 'medium', name: 'Medium', description: 'Moderate thinking', shortName: 'Med', color: 'text-green-600' },
  { id: 'high', name: 'High', description: 'Deep reasoning (CLI default)', shortName: 'Hi', color: 'text-yellow-600' },
  { id: 'xhigh', name: 'Extra High', description: 'Deeper than high (Opus 4.7 only; falls back to High elsewhere)', shortName: 'Xhi', color: 'text-orange-600' },
  { id: 'max', name: 'Max', description: 'Maximum effort (Opus 4.6/4.7 only)', shortName: 'Max', color: 'text-red-600' },
];

// ── Thinking ────────────────────────────────────────────────────────────

/**
 * Thinking config — controls extended thinking behavior. Re-exported
 * from the renderer-shared `lib/thinkingConfig` module so every UI
 * touch-point stays on the same canonical type. The legacy `'budget'`
 * variant was removed in v0.4.21; see lib/thinkingConfig.ts for why.
 */
export type { ThinkingConfig } from '@/lib/thinkingConfig';
import type { ThinkingConfig } from '@/lib/thinkingConfig';

export const THINKING_CONFIGS: { id: ThinkingConfig; name: string; description: string; shortName: string; color: string }[] = [
  { id: 'adaptive', name: 'Adaptive', description: 'Claude decides when and how much to think', shortName: 'On', color: 'text-sky-600' },
  { id: 'disabled', name: 'Off', description: 'No extended thinking', shortName: 'Off', color: 'text-foreground/70' },
];

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

// Mirrors the SDK's PermissionMode union exactly:
//   'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
// Order is UI ordering (least to most permissive-ish), not SDK enum order.
export const PERMISSION_MODES: PermissionMode[] = [
  {
    id: "default",
    name: "Ask",
    description:
      "Prompt when hooks/settings rules do not already allow or deny.",
    shortName: "ASK",
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
    color: "text-yellow-600",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Plan only; no tool execution.",
    shortName: "PLAN",
    icon: <ClipboardList className="h-3.5 w-3.5" />,
    color: "text-blue-600",
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
    color: "text-purple-600",
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
// anything while the rest of the app migrates to full SDK modes.
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
  /** "compact" (bottom bar), "expanded" (modal), or "form" (full-name
   *  trigger that fills its container — used in NewSessionForm). */
  variant?: "compact" | "expanded" | "form";
}

function EffortPickerDropdown({ effort, onSelect }: { effort: EffortLevel; onSelect: (level: EffortLevel) => void }) {
  return (
    <div className="w-[280px] p-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 pt-2 pb-1.5 border-b border-border/50 mb-1">
        Effort
      </div>
      {EFFORT_LEVELS.map((level) => (
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

export function EffortPicker({ effort, onEffortChange, open, onOpenChange, disabled, variant = "compact" }: EffortPickerProps) {
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
          content={<EffortPickerDropdown effort={effort} onSelect={handleSelect} />}
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
        content={<EffortPickerDropdown effort={effort} onSelect={handleSelect} />}
        open={open}
        onOpenChange={onOpenChange}
        align="start"
        side="bottom"
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
      content={<EffortPickerDropdown effort={effort} onSelect={handleSelect} />}
      open={open}
      onOpenChange={onOpenChange}
      align="start"
      side="top"
    />
  );
}

// ── Thinking Picker ─────────────────────────────────────────────────────

interface ThinkingPickerProps {
  thinkingConfig: ThinkingConfig;
  onThinkingConfigChange?: (config: ThinkingConfig) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  /** "compact" (bottom bar) or "form" (full-name trigger that fills its
   *  container — used in NewSessionForm). Defaults to "compact". */
  variant?: "compact" | "form";
}

function ThinkingPickerDropdown({
  thinkingConfig,
  onSelect,
}: {
  thinkingConfig: ThinkingConfig;
  onSelect: (config: ThinkingConfig) => void;
}) {
  return (
    <div className="w-[280px] p-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 pt-2 pb-1.5 border-b border-border/50 mb-1">
        Thinking
      </div>
      {THINKING_CONFIGS.map((cfg) => (
        <button
          key={cfg.id}
          onClick={() => { onSelect(cfg.id); }}
          className={cn(
            "w-full flex items-start gap-3 p-3 rounded-md transition-colors text-left",
            "hover:bg-accent",
            thinkingConfig === cfg.id && "bg-accent",
          )}
        >
          <span className={cn("text-sm font-bold mt-0.5", cfg.color)}>
            {cfg.shortName}
          </span>
          <div className="flex-1 space-y-1">
            <div className="font-medium text-sm">{cfg.name}</div>
            <div className="text-xs text-muted-foreground">{cfg.description}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

export function ThinkingPicker({
  thinkingConfig,
  onThinkingConfigChange,
  open,
  onOpenChange,
  disabled,
  variant = "compact",
}: ThinkingPickerProps) {
  const current = THINKING_CONFIGS.find((c) => c.id === thinkingConfig);

  const handleSelect = (config: ThinkingConfig) => {
    onThinkingConfigChange?.(config);
    onOpenChange(false);
  };

  if (variant === "form") {
    return (
      <Popover
        trigger={
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => { onOpenChange(!open); }}
            className="w-full justify-between h-9 px-3 font-normal gap-2"
          >
            <span className="flex items-center gap-2 min-w-0">
              <Brain className="h-3.5 w-3.5 opacity-70 shrink-0" />
              <span className={cn("text-xs font-semibold truncate", current?.color)}>
                {current?.name}
              </span>
            </span>
            <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
          </Button>
        }
        content={<ThinkingPickerDropdown thinkingConfig={thinkingConfig} onSelect={handleSelect} />}
        open={open}
        onOpenChange={onOpenChange}
        align="start"
        side="bottom"
      />
    );
  }

  return (
    <Popover
      trigger={
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.div whileTap={{ scale: 0.97 }} transition={{ duration: 0.15 }}>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                className="h-9 px-2 bg-background hover:bg-accent/50 gap-1 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent)]"
              >
                <Brain className="h-3.5 w-3.5 opacity-70" />
                <span className={cn("text-[10px] font-bold", current?.color)}>
                  {current?.shortName}
                </span>
                <ChevronUp className="h-3 w-3 ml-0.5 opacity-70" />
              </Button>
            </motion.div>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs font-medium">Thinking: {current?.name}</p>
            <p className="text-xs text-muted-foreground">{current?.description}</p>
          </TooltipContent>
        </Tooltip>
      }
      content={<ThinkingPickerDropdown thinkingConfig={thinkingConfig} onSelect={handleSelect} />}
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
      content={
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
      }
      open={open}
      onOpenChange={onOpenChange}
      align="start"
      side={isFormVariant ? "bottom" : "top"}
    />
  );
}
