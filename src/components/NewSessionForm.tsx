import React, { useEffect, useState } from "react";
import { Pencil, ChevronDown, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Popover } from "@/components/ui/popover";
import { AccountBadge } from "@/components/AccountBadge";
import { AgentPicker } from "@/components/shared/AgentPicker";
import { useAppCapabilities } from "@/contexts/AppCapabilitiesContext";
import { cn } from "@/lib/utils";
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  THINKING_CONFIGS,
  type EffortLevel,
  type ThinkingConfig,
} from "./ControlBar";
import { MODELS } from "./ModelPicker";
import type { AgentKind, CodexAuthStatus, SessionDefaults, SessionMode } from "@/lib/api";

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
  onChangeAccount?: () => void;
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
  agent,
  setAgent,
  agentPickerDisabled = false,
  onStart,
  onChangeAccount,
  codexAuthStatus,
  onCodexSignIn,
  className,
}) => {
  // Feature-flag gate (Task 25). When `OMNIFEX_ENABLE_CODEX=1` is unset
  // we hide the AgentPicker entirely and clamp the agent to 'claude' so
  // a stale persisted `'codex'` value (e.g. from a tab created before
  // the user disabled the flag) can't slip past into a Codex-only code
  // path. The clamp happens in an effect so we don't fight the parent's
  // state during render.
  const { codexEnabled } = useAppCapabilities();
  useEffect(() => {
    if (!codexEnabled && agent !== 'claude') {
      setAgent('claude');
    }
  }, [codexEnabled, agent, setAgent]);
  // Codex auth gating — only consulted on the codex agent path. We treat
  // `null` (status not yet loaded) the same as unauthenticated so submit
  // stays disabled until we definitively know we can start the session.
  const codexAuthenticated = agent === 'codex'
    ? codexAuthStatus?.authenticated === true
    : true;
  const showCodexAuthBanner = agent === 'codex' && !codexAuthenticated;
  // Codex doesn't carry a Claude account, so the Account selector is
  // hidden when Codex is picked — replaced with a quiet "Codex" badge
  // so the user still gets a clear indicator of which engine will run.
  // Task 14/15 plug in Codex sign-in state; for now the badge is text.
  const showAccountCell = agent === 'claude' && accountResolution !== null;
  const showCodexCell = agent === 'codex';
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
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium">New Session</h3>
        {codexEnabled && (
          <AgentPicker
            value={agent}
            onChange={setAgent}
            disabled={agentPickerDisabled}
          />
        )}
      </div>

      {/* Account (or Codex indicator) + 4 dropdowns on a single row, labels
          on top. The leftmost cell auto-sizes to fit whichever variant is
          showing — full AccountBadge + edit pencil for Claude, a compact
          "Codex" pill for Codex. The four dropdown columns split the
          remaining space equally. */}
      <div
        className={cn(
          "grid gap-2",
          showAccountCell || showCodexCell
            ? "grid-cols-[auto_1fr_1fr_1fr_1fr]"
            : "grid-cols-4",
        )}
      >
        {showAccountCell && (
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
                <AccountBadge name={accountResolution!.account.name} />
              </span>
              <Pencil className="h-3 w-3 opacity-50 shrink-0" />
            </Button>
          </div>
        )}
        {showCodexCell && (
          <div className="flex flex-col gap-1">
            <Label className="text-[10px] uppercase tracking-wider text-foreground/50">
              Agent
            </Label>
            <div
              className="inline-flex items-center justify-center h-9 px-3 rounded-md border border-input bg-muted/40 text-[11px] font-medium whitespace-nowrap"
              title="Codex doesn't use Claude accounts. Sign-in is per-machine."
            >
              Codex
            </div>
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
