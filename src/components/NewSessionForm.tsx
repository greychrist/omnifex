import React from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AccountBadge } from "@/components/AccountBadge";
import { cn } from "@/lib/utils";
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  THINKING_CONFIGS,
  type EffortLevel,
  type ThinkingConfig,
} from "./FloatingPromptInput";
import { MODELS } from "./ModelPicker";
import type { SessionDefaults } from "@/lib/api";

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
  autoAllowEnabled: boolean;
  setAutoAllowEnabled: (next: boolean) => void;
  onStart: () => void;
  onChangeAccount?: () => void;
  className?: string;
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
  autoAllowEnabled,
  setAutoAllowEnabled,
  onStart,
  onChangeAccount,
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
        <div className="flex items-center gap-2 text-sm">
          <span className="text-foreground/40 shrink-0">Account:</span>
          <AccountBadge name={accountResolution.account.name} />
          {onChangeAccount && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onChangeAccount}
              className="h-6 px-2 text-xs gap-1 text-foreground/60 hover:text-foreground"
              title="Use a different account for this session"
            >
              <Pencil className="h-3 w-3" />
              Change
            </Button>
          )}
        </div>
      )}

      <div className="space-y-1">
        <Label className="text-xs text-foreground/60">Model</Label>
        <div className="grid grid-cols-2 gap-2">
          {MODELS.map((model) => (
            <Button
              key={model.id}
              size="sm"
              variant={selectedModel === model.id ? "default" : "outline"}
              onClick={() => setSelectedModel(model.id)}
              className="justify-start"
              title={model.description}
            >
              {model.name}
            </Button>
          ))}
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
        <Label className="text-xs text-foreground/60">Thinking</Label>
        <div className="grid grid-cols-3 gap-1">
          {THINKING_CONFIGS.map((cfg) => (
            <Button
              key={cfg.id}
              size="sm"
              variant={thinkingConfig === cfg.id ? "default" : "outline"}
              onClick={() => setThinkingConfig(cfg.id)}
              className="flex-col gap-0.5 h-auto py-2 px-1"
              title={cfg.description}
            >
              <span className={cn("text-xs font-bold", cfg.color)}>{cfg.shortName}</span>
              <span className="text-[9px] leading-tight">{cfg.name}</span>
            </Button>
          ))}
        </div>
        <p className="text-[10px] text-foreground/40">
          {THINKING_CONFIGS.find((c) => c.id === thinkingConfig)?.description}
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
