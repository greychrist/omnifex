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
  type EffortLevel,
} from "./ControlBar";
import { useModelCatalog } from "@/lib/modelCatalog";
import type { AgentKind, CodexAuthStatus, ResolvePair, SessionMode } from "@/lib/api";

interface NewSessionFormProps {
  /**
   * Per-engine routing for the current project. The form reads the slot for
   * the currently-selected `agent` (`resolvePair[agent]`) so flipping the
   * AgentPicker swaps the displayed account between the Claude and Codex
   * routing targets. A null slot for the active engine renders a "Choose
   * account" affordance instead of an AccountBadge.
   */
  resolvePair: ResolvePair;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  effort: EffortLevel;
  setEffort: (effort: EffortLevel) => void;
  permissionMode: string;
  setPermissionMode: (mode: string) => void;
  sessionStartMode: SessionMode;
  setSessionStartMode: (mode: SessionMode) => void;
  /**
   * Which engine drives the session. Lifted to the parent so the form's
   * caller can seed it from the path-rule resolver (`api.resolveAccountForProject`
   * returns `{ agent, account }`) and so the value survives flipping the
   * form into a chat tab via `initialSessionConfig`.
   */
  agent: AgentKind;
  setAgent: (agent: AgentKind) => void;
  /**
   * When true, disable the agent picker (e.g. while the form is loading or
   * an in-flight session start is racing). The picker still renders so the
   * current value stays visible.
   */
  agentPickerDisabled?: boolean;
  onStart: () => void;
  /**
   * Open the account picker to change the resolved account for the active
   * engine. Surfaced as the Pencil affordance next to a present account.
   */
  onChangeAccount?: () => void;
  /**
   * Open the account picker when the active engine has NO resolved account
   * (the slot is null). Surfaced as the "Choose account" button that replaces
   * the AccountBadge. Distinct from `onChangeAccount` so callers can scope the
   * picker (e.g. engineFilter) and re-fetch the pair after a pick.
   */
  onChooseAccount?: () => void;
  /**
   * Current Codex auth status. Threaded in from the parent (typically the
   * `App` shell, which subscribes once at app startup) so the form stays a
   * pure presentation component. `null` means "auth status hasn't loaded
   * yet" — treated the same as unauthenticated for gating: we keep submit
   * disabled rather than letting the user start a Codex session against
   * potentially-unauthenticated state. Only consulted when `agent === 'codex'`.
   */
  codexAuthStatus?: CodexAuthStatus | null;
  /**
   * Called when the user clicks the inline "Sign in" button in the
   * Codex-unauthenticated banner. Parent should open the
   * `CodexSignInModal`. Required when `agent === 'codex'` is reachable
   * in the form; if omitted the banner renders without a sign-in
   * affordance (only useful for snapshot tests).
   */
  onCodexSignIn?: () => void;
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
  resolvePair,
  selectedModel,
  setSelectedModel,
  effort,
  setEffort,
  permissionMode,
  setPermissionMode,
  sessionStartMode,
  setSessionStartMode,
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
  // Codex auth gating — only consulted on the codex agent path. We treat
  // `null` (status not yet loaded) the same as unauthenticated so submit
  // stays disabled until we definitively know we can start the session.
  const codexAuthenticated = agent === 'codex'
    ? codexAuthStatus?.authenticated === true
    : true;
  const showCodexAuthBanner = agent === 'codex' && !codexAuthenticated;
  // Per-engine routing target for the currently-selected agent. Codex
  // accounts are real accounts now, so both engines render a full
  // AccountBadge when their slot resolves. A null slot for the active
  // engine means no override/path rule routes here yet — render a
  // "Choose account" affordance instead.
  const activeSlot = resolvePair[agent];
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);

  // Dynamic model catalog for the resolved Claude account (falls back to the
  // static list when no account routes here yet, or for the Codex engine —
  // whose model options this picker has never differentiated).
  const { models: modelList, raw: modelCatalogRaw } = useModelCatalog(
    agent === 'claude' ? activeSlot?.account.config_dir : undefined,
  );
  const selectedModelData = modelList.find((m) => m.id === selectedModel) ?? modelList[0];
  const selectedRawModel = modelCatalogRaw.find((m) => m.value === selectedModel);
  const effortLevelList = selectedRawModel?.supportedEffortLevels
    ? EFFORT_LEVELS.filter((l) => selectedRawModel.supportedEffortLevels!.includes(l.id))
    : EFFORT_LEVELS;
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

      {/* Account cell + 4 dropdowns on a single row, labels on top. The
          leftmost cell auto-sizes — it shows the resolved AccountBadge (for
          either engine) with an edit pencil, or a "Choose account" button
          when the active engine has no routing target yet. The four dropdown
          columns split the remaining space equally. */}
      <div className="grid gap-2 grid-cols-[auto_1fr_1fr_1fr_1fr]">
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
              className="justify-between h-9 px-2 font-normal gap-2 whitespace-nowrap"
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
              className="justify-center h-9 px-3 font-normal whitespace-nowrap"
              title="No account routes here yet — choose one for this engine"
            >
              Choose account
            </Button>
          )}
        </div>

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
          Start in Terminal mode (embedded terminal — same CLI, no structured chat UI)
        </label>
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
