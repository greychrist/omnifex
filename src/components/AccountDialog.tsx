import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ColorSwatchGrid } from "@/components/ui/ColorSwatchGrid";
import { IconPicker, ICON_MAP } from "./IconPicker";
import { SessionDefaultsRow } from "@/components/shared/SessionDefaultsRow";
import { CodexSignInModal } from "@/components/codex/CodexSignInModal";
import { useCodexAuthStatus } from "@/hooks/useCodexAuthStatus";
import {
  api,
  type Account,
  type AccountEngine,
  type SessionDefaults,
} from "@/lib/api";
import { FolderOpen, LogIn, LogOut, Check } from "lucide-react";

export interface AccountDialogSavePayload {
  name: string;
  configDir: string;
  engine: AccountEngine;
  subscriptionLabel: string;
  hasCost: boolean;
  color?: string;
  icon?: string;
  sessionDefaults?: SessionDefaults;
}

export interface AccountDialogProps {
  mode: "add" | "edit";
  /** Required when mode='edit'. */
  account?: Account;
  open: boolean;
  onClose: () => void;
  onSave: (payload: AccountDialogSavePayload) => void;
}

// Native directory picker. Same call AccountSettings uses so the Browse
// button opens the OS folder dialog and pre-seeds the home dir.
async function pickFolder(defaultPath?: string): Promise<string | null> {
  try {
    const paths = (await window.electronAPI.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select Folder",
      defaultPath: defaultPath || (await api.getHomeDirectory()),
    })) as string[] | null;
    return paths?.[0] ?? null;
  } catch {
    return null;
  }
}

// Per-engine session-default seeds applied when the engine radio flips in
// add mode. Codex has no Thinking axis; Claude does.
const ENGINE_DEFAULTS: Record<
  AccountEngine,
  { permission: string; effort: string }
> = {
  claude: { permission: "acceptEdits", effort: "high" },
  codex: { permission: "workspace-edit", effort: "medium" },
};

/**
 * Unified Add/Edit account dialog. Add mode lets you pick the engine
 * (Claude vs Codex); edit mode locks the engine (it's immutable
 * post-create) and surfaces the Codex sign-in row for codex accounts.
 *
 * Visual primitives are shared with AccountSettings: ColorSwatchGrid for
 * color, IconPicker for icons, and the same showOpenDialog-based folder
 * picker for the config directory.
 */
export const AccountDialog: React.FC<AccountDialogProps> = ({
  mode,
  account,
  open,
  onClose,
  onSave,
}) => {
  const [name, setName] = useState("");
  const [configDir, setConfigDir] = useState("");
  const [engine, setEngine] = useState<AccountEngine>("claude");
  const [subscriptionLabel, setSubscriptionLabel] = useState("");
  const [hasCost, setHasCost] = useState(true);
  const [color, setColor] = useState("#3b82f6");
  const [icon, setIcon] = useState("user");

  // Session-defaults fields, flattened so they can be wired straight into
  // SessionDefaultsRow.
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState(ENGINE_DEFAULTS.claude.effort);
  const [thinking, setThinking] = useState<string>("adaptive");
  const [permission, setPermission] = useState(ENGINE_DEFAULTS.claude.permission);

  const [showIconPicker, setShowIconPicker] = useState(false);
  const [showCodexSignIn, setShowCodexSignIn] = useState(false);

  // Seed local state whenever the dialog opens (or the target account
  // changes). Add mode resets to defaults; edit mode mirrors the account.
  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && account) {
      setName(account.name);
      setConfigDir(account.config_dir);
      setEngine(account.engine);
      setSubscriptionLabel(account.subscription_label ?? "");
      setHasCost(account.has_cost);
      setColor(account.color ?? "#3b82f6");
      setIcon(account.icon ?? "user");
      const sd = account.session_defaults ?? {};
      setModel(sd.model ?? "");
      setEffort(sd.effort ?? ENGINE_DEFAULTS[account.engine].effort);
      setThinking(sd.thinkingConfig ?? "adaptive");
      setPermission(sd.permissionMode ?? ENGINE_DEFAULTS[account.engine].permission);
    } else {
      setName("");
      setConfigDir("");
      setEngine("claude");
      setSubscriptionLabel("");
      setHasCost(true);
      setColor("#3b82f6");
      setIcon("user");
      setModel("");
      setEffort(ENGINE_DEFAULTS.claude.effort);
      setThinking("adaptive");
      setPermission(ENGINE_DEFAULTS.claude.permission);
    }
    // mode/account are intentionally the only seed triggers; subsequent
    // field edits are owned by the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, account]);

  // When the engine flips in add mode, reset engine-specific session
  // defaults to sensible per-engine values. Edit mode never flips engine
  // (radios are disabled), so this is a no-op there.
  useEffect(() => {
    if (mode !== "add") return;
    setEffort(ENGINE_DEFAULTS[engine].effort);
    setPermission(ENGINE_DEFAULTS[engine].permission);
  }, [engine, mode]);

  // Codex auth status — only watched for codex accounts in edit mode (an
  // add-mode account has no config dir on disk to authenticate yet).
  const codexAuth = useCodexAuthStatus(
    engine === "codex" && mode === "edit" ? configDir : null,
  );

  const handleSave = (): void => {
    onSave({
      name,
      configDir,
      engine,
      subscriptionLabel,
      hasCost,
      color,
      icon,
      sessionDefaults: {
        model: model || undefined,
        effort: (effort || undefined) as SessionDefaults["effort"],
        thinkingConfig:
          engine === "claude"
            ? (thinking as SessionDefaults["thinkingConfig"])
            : undefined,
        permissionMode: permission,
      },
    });
  };

  const handleSignOut = (): void => {
    void api.codexLogout(configDir).catch((err) => {
      console.error("Failed to sign out of Codex:", err);
    });
  };

  const radiosDisabled = mode === "edit";
  const showCodexRow = engine === "codex" && mode === "edit";

  const IconComponent = ICON_MAP[icon] || ICON_MAP.user;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add account" : "Edit account"}</DialogTitle>
          <DialogDescription>
            Configure the engine, config directory, appearance, and session
            defaults for this account.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Engine radios */}
          <fieldset className="space-y-1">
            <legend className="text-xs text-muted-foreground">Engine</legend>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="account-engine"
                  aria-label="Claude"
                  checked={engine === "claude"}
                  disabled={radiosDisabled}
                  onChange={() => { setEngine("claude"); }}
                />
                Claude
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="account-engine"
                  aria-label="Codex"
                  checked={engine === "codex"}
                  disabled={radiosDisabled}
                  onChange={() => { setEngine("codex"); }}
                />
                Codex
              </label>
            </div>
          </fieldset>

          {/* Name */}
          <div className="space-y-1">
            <label htmlFor="account-name" className="text-xs text-muted-foreground">
              Name
            </label>
            <Input
              id="account-name"
              placeholder="Account name (e.g., personal)"
              value={name}
              onChange={(e) => { setName(e.target.value); }}
              className="h-8 text-sm"
            />
          </div>

          {/* Config directory + browse */}
          <div className="space-y-1">
            <label htmlFor="account-config-dir" className="text-xs text-muted-foreground">
              Config directory
            </label>
            <div className="flex gap-1">
              <Input
                id="account-config-dir"
                placeholder="Config directory (e.g., ~/.claude-personal)"
                value={configDir}
                onChange={(e) => { setConfigDir(e.target.value); }}
                className="h-8 text-sm flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2"
                title="Browse..."
                onClick={() => {
                  void pickFolder(configDir || undefined).then((folder) => {
                    if (folder) setConfigDir(folder);
                  });
                }}
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

          {/* Subscription label */}
          <div className="space-y-1">
            <label htmlFor="account-subscription" className="text-xs text-muted-foreground">
              Subscription label
            </label>
            <Input
              id="account-subscription"
              placeholder="e.g., Max, Pro, Plus"
              value={subscriptionLabel}
              onChange={(e) => { setSubscriptionLabel(e.target.value); }}
              className="h-8 text-sm"
            />
          </div>

          {/* Has cost */}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Has cost"
              checked={hasCost}
              onChange={(e) => { setHasCost(e.target.checked); }}
            />
            Has cost
          </label>

          {/* Color + icon */}
          <div className="space-y-2">
            <div className="flex items-start gap-3">
              <label className="text-xs text-muted-foreground w-14 mt-1">Color</label>
              <ColorSwatchGrid value={color} onChange={setColor} />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs text-muted-foreground w-14">Icon</label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => { setShowIconPicker(true); }}
                className="h-8 px-2"
              >
                {IconComponent ? <IconComponent className="w-4 h-4" /> : null}
                <span className="ml-2 text-xs">{icon}</span>
              </Button>
            </div>
          </div>

          {/* Session defaults */}
          <SessionDefaultsRow
            engine={engine}
            model={model}
            setModel={setModel}
            effort={effort}
            setEffort={setEffort}
            permissionMode={permission}
            setPermissionMode={setPermission}
          />

          {/* Codex sign-in row (edit + codex only) */}
          {showCodexRow && (
            <div className="space-y-2 pt-2">
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-muted/30">
                <div className="flex-1 min-w-0">
                  {codexAuth?.authenticated ? (
                    <span className="text-sm font-medium truncate">
                      {codexAuth.email ?? `Signed in (${codexAuth.mode ?? "oauth"})`}
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">Not authenticated</span>
                  )}
                </div>
                {codexAuth?.authenticated ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={handleSignOut}
                  >
                    <LogOut className="w-3 h-3 mr-1" />
                    Sign out
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => { setShowCodexSignIn(true); }}
                  >
                    <LogIn className="w-3 h-3 mr-1" />
                    Sign in
                  </Button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                OPENAI_API_KEY env var, if set, applies machine-wide to every
                Codex account.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            <Check className="mr-2 h-4 w-4" />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>

      <IconPicker
        value={icon}
        onSelect={setIcon}
        isOpen={showIconPicker}
        onClose={() => { setShowIconPicker(false); }}
      />

      {showCodexRow && (
        <CodexSignInModal
          open={showCodexSignIn}
          onClose={() => { setShowCodexSignIn(false); }}
          configDir={configDir}
        />
      )}
    </Dialog>
  );
};
