import React, { useState } from "react";
import { Pencil, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Popover } from "@/components/ui/popover";
import { AccountBadge } from "@/components/AccountBadge";
import { cn } from "@/lib/utils";
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  THINKING_CONFIGS,
  type EffortLevel,
  type ThinkingConfig,
} from "./ControlBar";
import { MODELS } from "./ModelPicker";
import type { SessionDefaults, SessionMode } from "@/lib/api";

export interface NewSessionFormAccountResolution {
  account: { name: string; account_type: string; config_dir: string; session_defaults?: SessionDefaults };
  match_type: string;
  match_detail: string;
}

interface NewSessionFormProps {
  accountResolution: NewSessionFormAccountResolution | null;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  effort: EffortLevel;
  setEffort: (effort: EffortLevel) => void;
  thinkingConfig: ThinkingConfig;
  setThinkingConfig: (config: ThinkingConfig) => void;
  permissionMode: string;
  setPermissionMode: (mode: string) => void;
  sessionStartMode: SessionMode;
  setSessionStartMode: (mode: SessionMode) => void;
  onStart: () => void;
  onChangeAccount?: () => void;
  className?: string;
}

/**
 * Trigger button for the form-variant dropdowns. Outlined, fills the
 * column, shows a chevron on the right. The label slot is whatever the
 * caller wants (matches the visual content of the corresponding row).
 * Tight padding so 4 dropdowns fit on a single row inside `max-w-md`.
 */
function DropdownTrigger({
  open,
  onClick,
  title,
  children,
}: {
  open: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="w-full justify-between h-9 px-2 font-normal gap-1"
      aria-expanded={open}
      title={title}
    >
      <span className="flex items-center gap-1 min-w-0 overflow-hidden">{children}</span>
      <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
    </Button>
  );
}

/** Single dropdown row that mirrors the visual of one button from the
 *  pre-existing button grid. Highlighted when this row is the selected
 *  option. */
function DropdownRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 rounded-md text-left transition-colors",
        "hover:bg-accent",
        selected && "bg-accent",
      )}
    >
      {children}
    </button>
  );
}

export const NewSessionForm: React.FC<NewSessionFormProps> = ({
  accountResolution,
  selectedModel,
  setSelectedModel,
  effort,
  setEffort,
  thinkingConfig,
  setThinkingConfig,
  permissionMode,
  setPermissionMode,
  sessionStartMode,
  setSessionStartMode,
  onStart,
  onChangeAccount,
  className,
}) => {
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);

  const selectedModelData = MODELS.find((m) => m.id === selectedModel) ?? MODELS[0];
  const selectedEffort = EFFORT_LEVELS.find((e) => e.id === effort);
  const selectedThinking = THINKING_CONFIGS.find((c) => c.id === thinkingConfig);
  const selectedPermission =
    PERMISSION_MODES.find((m) => m.id === permissionMode) ?? PERMISSION_MODES[0];

  return (
    <Card
      className={cn(
        "p-4 w-full h-full space-y-3",
        className,
      )}
    >
      <h3 className="text-base font-medium">New Session</h3>

      {/* Account + 4 dropdowns on a single row, labels on top. The Account
          cell shows the current AccountBadge in a dropdown-shaped trigger
          that fires onChangeAccount on click — same visual rhythm as the
          other four selectors. */}
      <div
        className={cn(
          "grid gap-2",
          // Account column auto-sizes to fit the badge (no clipping); the
          // four dropdown columns split the remaining space equally.
          accountResolution
            ? "grid-cols-[auto_1fr_1fr_1fr_1fr]"
            : "grid-cols-4",
        )}
      >
        {accountResolution && (
          <div className="flex flex-col gap-1">
            <Label className="text-[10px] uppercase tracking-wider text-foreground/50">
              Account
            </Label>
            <Button
              variant="outline"
              size="sm"
              onClick={onChangeAccount}
              disabled={!onChangeAccount}
              className="justify-between h-9 px-2 font-normal gap-2 whitespace-nowrap"
              title="Use a different account for this session"
            >
              <span className="flex items-center gap-1">
                <AccountBadge name={accountResolution.account.name} />
              </span>
              <Pencil className="h-3 w-3 opacity-50 shrink-0" />
            </Button>
          </div>
        )}

        {/* Model */}
        <div className="flex flex-col gap-1 min-w-0">
          <Label className="text-[10px] uppercase tracking-wider text-foreground/50">Model</Label>
          <Popover
            open={modelOpen}
            onOpenChange={setModelOpen}
            align="start"
            side="bottom"
            trigger={
              <DropdownTrigger
                open={modelOpen}
                onClick={() => { setModelOpen(!modelOpen); }}
                title={selectedModelData.name}
              >
                <span className="text-[11px] truncate">{selectedModelData.name}</span>
              </DropdownTrigger>
            }
            content={
              <div className="w-[260px] p-1">
                {MODELS.map((model) => (
                  <DropdownRow
                    key={model.id}
                    selected={model.id === selectedModel}
                    onClick={() => {
                      setSelectedModel(model.id);
                      setModelOpen(false);
                    }}
                  >
                    <span className="text-xs">{model.name}</span>
                  </DropdownRow>
                ))}
              </div>
            }
          />
        </div>

        {/* Effort */}
        <div className="flex flex-col gap-1 min-w-0">
          <Label className="text-[10px] uppercase tracking-wider text-foreground/50">Effort</Label>
          <Popover
            open={effortOpen}
            onOpenChange={setEffortOpen}
            align="start"
            side="bottom"
            trigger={
              <DropdownTrigger
                open={effortOpen}
                onClick={() => { setEffortOpen(!effortOpen); }}
                title={selectedEffort?.description}
              >
                <span className={cn("text-[11px] font-bold shrink-0", selectedEffort?.color)}>
                  {selectedEffort?.shortName}
                </span>
                <span className="text-[10px] leading-tight truncate">{selectedEffort?.name}</span>
              </DropdownTrigger>
            }
            content={
              <div className="w-[240px] p-1">
                {EFFORT_LEVELS.map((level) => (
                  <DropdownRow
                    key={level.id}
                    selected={level.id === effort}
                    onClick={() => {
                      setEffort(level.id);
                      setEffortOpen(false);
                    }}
                  >
                    <span className={cn("text-xs font-bold w-10 shrink-0", level.color)}>
                      {level.shortName}
                    </span>
                    <span className="text-[10px] leading-tight">{level.name}</span>
                  </DropdownRow>
                ))}
              </div>
            }
          />
        </div>

        {/* Thinking */}
        <div className="flex flex-col gap-1 min-w-0">
          <Label className="text-[10px] uppercase tracking-wider text-foreground/50">Thinking</Label>
          <Popover
            open={thinkingOpen}
            onOpenChange={setThinkingOpen}
            align="start"
            side="bottom"
            trigger={
              <DropdownTrigger
                open={thinkingOpen}
                onClick={() => { setThinkingOpen(!thinkingOpen); }}
                title={selectedThinking?.description}
              >
                <span className={cn("text-[11px] font-bold shrink-0", selectedThinking?.color)}>
                  {selectedThinking?.shortName}
                </span>
                <span className="text-[10px] leading-tight truncate">{selectedThinking?.name}</span>
              </DropdownTrigger>
            }
            content={
              <div className="w-[240px] p-1">
                {THINKING_CONFIGS.map((cfg) => (
                  <DropdownRow
                    key={cfg.id}
                    selected={cfg.id === thinkingConfig}
                    onClick={() => {
                      setThinkingConfig(cfg.id);
                      setThinkingOpen(false);
                    }}
                  >
                    <span className={cn("text-xs font-bold w-10 shrink-0", cfg.color)}>
                      {cfg.shortName}
                    </span>
                    <span className="text-[10px] leading-tight">{cfg.name}</span>
                  </DropdownRow>
                ))}
              </div>
            }
          />
        </div>

        {/* Permissions */}
        <div className="flex flex-col gap-1 min-w-0">
          <Label className="text-[10px] uppercase tracking-wider text-foreground/50">Permissions</Label>
          <Popover
            open={permissionsOpen}
            onOpenChange={setPermissionsOpen}
            align="start"
            side="bottom"
            trigger={
              <DropdownTrigger
                open={permissionsOpen}
                onClick={() => { setPermissionsOpen(!permissionsOpen); }}
                title={selectedPermission.description}
              >
                <span className={cn("shrink-0", selectedPermission.color)}>
                  {selectedPermission.icon}
                </span>
                <span className={cn("text-[11px] truncate", selectedPermission.color)}>
                  {selectedPermission.name}
                </span>
              </DropdownTrigger>
            }
            content={
              <div className="w-[260px] p-1">
                {PERMISSION_MODES.map((mode) => (
                  <DropdownRow
                    key={mode.id}
                    selected={mode.id === permissionMode}
                    onClick={() => {
                      setPermissionMode(mode.id);
                      setPermissionsOpen(false);
                    }}
                  >
                    <span className={cn("shrink-0", mode.color)}>{mode.icon}</span>
                    <span className={cn("text-xs", mode.color)}>{mode.name}</span>
                  </DropdownRow>
                ))}
              </div>
            }
          />
        </div>
      </div>

      <div className="flex items-center gap-2 text-sm pt-1">
        <input
          id="start-in-terminal"
          type="checkbox"
          checked={sessionStartMode === 'tui'}
          onChange={(e) => { setSessionStartMode(e.target.checked ? 'tui' : 'rich'); }}
          className="rounded border-input"
        />
        <label htmlFor="start-in-terminal" className="cursor-pointer text-muted-foreground">
          Start in Terminal mode (uses local Claude CLI, no SDK budget)
        </label>
      </div>

      <Button className="w-full" onClick={onStart}>
        Start Session
      </Button>
    </Card>
  );
};
