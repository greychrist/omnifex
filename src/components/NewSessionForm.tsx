import React from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AccountBadge } from "@/components/AccountBadge";
import { cn } from "@/lib/utils";
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type EffortLevel,
} from "./FloatingPromptInput";

export interface NewSessionFormAccountResolution {
  account: { name: string; account_type: string; config_dir: string };
  match_type: string;
  match_detail: string;
}

interface NewSessionFormProps {
  accountResolution: NewSessionFormAccountResolution | null;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  effort: EffortLevel;
  setEffort: (effort: EffortLevel) => void;
  permissionMode: string;
  setPermissionMode: (mode: string) => void;
  autoAllowEnabled: boolean;
  setAutoAllowEnabled: (next: boolean) => void;
  onStart: () => void;
  className?: string;
}

export const NewSessionForm: React.FC<NewSessionFormProps> = ({
  accountResolution,
  selectedModel,
  setSelectedModel,
  effort,
  setEffort,
  permissionMode,
  setPermissionMode,
  autoAllowEnabled,
  setAutoAllowEnabled,
  onStart,
  className,
}) => {
  return (
    <div
      className={cn(
        "border border-border/50 rounded-lg p-6 bg-background/80 w-full max-w-md space-y-4",
        className,
      )}
    >
      <h3 className="text-base font-medium">New Session</h3>

      {accountResolution && (
        <div className="space-y-1 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-foreground/40 w-24 shrink-0">Account:</span>
            <AccountBadge name={accountResolution.account.name} />
            <span className="text-foreground/50 text-xs">
              ({accountResolution.account.account_type})
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-foreground/40 w-24 shrink-0">Config:</span>
            <span className="font-mono text-xs text-foreground/50 truncate">
              {accountResolution.account.config_dir}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-foreground/40 w-24 shrink-0">Matched by:</span>
            <span className="text-xs text-foreground/60">
              {accountResolution.match_type === "path_rule"
                ? "Path rule"
                : accountResolution.match_type === "project_override"
                  ? "Project override"
                  : "Default account"}
              {" — "}
              {accountResolution.match_detail}
            </span>
          </div>
        </div>
      )}

      <div className="space-y-1">
        <Label className="text-xs text-foreground/60">Model</Label>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={selectedModel === "opus[1m]" ? "default" : "outline"}
            onClick={() => setSelectedModel("opus[1m]")}
            className="flex-1"
          >
            Opus 1M
          </Button>
          <Button
            size="sm"
            variant={selectedModel === "opus" ? "default" : "outline"}
            onClick={() => setSelectedModel("opus")}
            className="flex-1"
          >
            Opus
          </Button>
          <Button
            size="sm"
            variant={selectedModel === "sonnet" ? "default" : "outline"}
            onClick={() => setSelectedModel("sonnet")}
            className="flex-1"
          >
            Sonnet
          </Button>
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-foreground/60">Effort</Label>
        <div className="grid grid-cols-5 gap-1">
          {EFFORT_LEVELS.map((level) => (
            <Button
              key={level.id}
              size="sm"
              variant={effort === level.id ? "default" : "outline"}
              onClick={() => setEffort(level.id)}
              className="flex-col gap-0.5 h-auto py-2 px-1"
              title={level.description}
            >
              <span className={cn("text-xs font-bold", level.color)}>
                {level.shortName}
              </span>
              <span className="text-[9px] leading-tight">{level.name}</span>
            </Button>
          ))}
        </div>
        <p className="text-[10px] text-foreground/40">
          {EFFORT_LEVELS.find((e) => e.id === effort)?.description}
        </p>
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-foreground/60">Permissions</Label>
        <div className="grid grid-cols-2 gap-2">
          {PERMISSION_MODES.map((mode) => (
            <Button
              key={mode.id}
              size="sm"
              variant={permissionMode === mode.id ? "default" : "outline"}
              onClick={() => setPermissionMode(mode.id)}
              className={cn(
                "justify-start gap-2",
                permissionMode !== mode.id && mode.color,
              )}
              title={mode.description}
            >
              {mode.icon}
              <span className="text-xs">{mode.name}</span>
            </Button>
          ))}
        </div>
        <p className="text-[10px] text-foreground/40">
          {PERMISSION_MODES.find((m) => m.id === permissionMode)?.description}
        </p>
      </div>

      {permissionMode === "default" && (
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-xs text-foreground/60">Auto-Allow Tools</Label>
            <p className="text-[10px] text-foreground/40">
              {autoAllowEnabled
                ? '"Always Allow" option shown on permission prompts'
                : "Every tool use requires explicit approval"}
            </p>
          </div>
          <Button
            size="sm"
            variant={autoAllowEnabled ? "default" : "outline"}
            onClick={() => setAutoAllowEnabled(!autoAllowEnabled)}
            className="text-xs"
          >
            {autoAllowEnabled ? "On" : "Off"}
          </Button>
        </div>
      )}

      <Button className="w-full" onClick={onStart}>
        Start Session
      </Button>
    </div>
  );
};
