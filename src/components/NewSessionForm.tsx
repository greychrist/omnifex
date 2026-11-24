import React, { useState } from "react";
import { Pencil, ChevronDown, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Popover } from "@/components/ui/popover";
import { AccountBadge } from "@/components/AccountBadge";
import { AgentPicker } from "@/components/shared/AgentPicker";
import { cn } from "@/lib/utils";
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  catalogEffortLevels,
  visibleEffortLevels,
  type EffortLevel,
} from "./ControlBar";
import { useModelCatalog } from "@/lib/modelCatalog";
import type { AgentKind, CodexAuthStatus, ResolvePair } from "@/lib/api";

interface NewSessionFormProps {
  resolvePair: ResolvePair;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  effort: EffortLevel;
  setEffort: (effort: EffortLevel) => void;
  permissionMode: string;
  setPermissionMode: (mode: string) => void;
  agent: AgentKind;
  setAgent: (agent: AgentKind) => void;
  agentPickerDisabled?: boolean;
  onStart: () => void;
  onChangeAccount?: () => void;
  onChooseAccount?: () => void;
  /** `null` (not loaded yet) gates Codex like unauthenticated. */
  codexAuthStatus?: CodexAuthStatus | null;
  onCodexSignIn?: () => void;
  className?: string;
}

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
      className="w-full justify-between min-h-9 h-auto flex-1 px-2 font-normal gap-1"
      aria-expanded={open}
      title={title}
    >
      <span className="flex items-center gap-1 min-w-0 overflow-hidden">{children}</span>
      <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
    </Button>
  );
}

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
  resolvePair,
  selectedModel,
  setSelectedModel,
  effort,
  setEffort,
  permissionMode,
  setPermissionMode,
  agent,
  setAgent,
  agentPickerDisabled = false,
  onStart,
  onChangeAccount,
  onChooseAccount,
  codexAuthStatus,
  onCodexSignIn,
  className,
}) => {
  const codexAuthenticated = agent === 'codex'
    ? codexAuthStatus?.authenticated === true
    : true;
  const showCodexAuthBanner = agent === 'codex' && !codexAuthenticated;
  const activeSlot = resolvePair[agent];
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);

  const { models: modelList, raw: modelCatalogRaw } = useModelCatalog(
    agent === 'claude' ? activeSlot?.account.config_dir : undefined,
  );
  const selectedModelData = modelList.find((m) => m.id === selectedModel) ?? modelList[0];
  const selectedRawModel = modelCatalogRaw.find((m) => m.value === selectedModel);
  const effortLevelList = visibleEffortLevels(catalogEffortLevels(selectedRawModel));
  const selectedEffort = EFFORT_LEVELS.find((e) => e.id === effort);
  const selectedPermission =
    PERMISSION_MODES.find((m) => m.id === permissionMode) ?? PERMISSION_MODES[0];

  return (
    <Card
      className={cn(
        "p-4 w-full h-full space-y-3",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium">New Session</h3>
        <AgentPicker
          value={agent}
          onChange={setAgent}
          disabled={agentPickerDisabled}
        />
      </div>

      <div className="grid gap-2 grid-cols-[auto_minmax(0,1.8fr)_minmax(0,0.7fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-1">
          <Label className="text-[10px] uppercase tracking-wider text-foreground/50">
            Account
          </Label>
          {activeSlot ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onChangeAccount}
              disabled={!onChangeAccount}
              className="justify-between min-h-9 h-auto flex-1 px-2 font-normal gap-2 whitespace-nowrap"
              title="Use a different account for this session"
            >
              <span className="flex items-center gap-1">
                <AccountBadge name={activeSlot.account.name} />
              </span>
              <Pencil className="h-3 w-3 opacity-50 shrink-0" />
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={onChooseAccount}
              disabled={!onChooseAccount}
              className="justify-center min-h-9 h-auto flex-1 px-3 font-normal whitespace-nowrap"
              title="No account routes here yet — choose one for this engine"
            >
              Choose account
            </Button>
          )}
        </div>

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
                <span className="flex flex-col items-start min-w-0 py-1">
                  <span className="text-[11px] truncate">{selectedModelData.name}</span>
                  {selectedModelData.description && (
                    <span className="text-[10px] text-muted-foreground truncate">
                      {selectedModelData.description}
                    </span>
                  )}
                </span>
              </DropdownTrigger>
            }
            content={
              <div className="w-[260px] p-1">
                {modelList.map((model) => (
                  <DropdownRow
                    key={model.id}
                    selected={model.id === selectedModel}
                    onClick={() => {
                      setSelectedModel(model.id);
                      setModelOpen(false);
                    }}
                  >
                    <span className="flex flex-col items-start min-w-0">
                      <span className="text-xs">{model.name}</span>
                      {model.description && (
                        <span className="text-[10px] text-muted-foreground truncate">
                          {model.description}
                        </span>
                      )}
                    </span>
                  </DropdownRow>
                ))}
              </div>
            }
          />
        </div>

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
                {effortLevelList.map((level) => (
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

      {showCodexAuthBanner && (
        <div
          className="flex items-center gap-3 px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/10 text-xs"
          role="alert"
          data-testid="codex-auth-banner"
        >
          <span className="flex-1 text-foreground/80">
            You need to sign in to Codex first.
          </span>
          {onCodexSignIn && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={onCodexSignIn}
            >
              <LogIn className="w-3 h-3 mr-1" />
              Sign in
            </Button>
          )}
        </div>
      )}

      <Button
        className="w-full"
        onClick={onStart}
        disabled={agent === 'codex' && !codexAuthenticated}
      >
        Start Session
      </Button>
    </Card>
  );
};
