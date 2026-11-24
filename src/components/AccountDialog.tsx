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
import { platform, type BrowserInfo } from "@/lib/platform";
import { getSignInBrowser, setSignInBrowser } from "@/lib/signInBrowser";
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
  /** Expected login email. null turns the session-start check off. */
  expectedEmail: string | null;
}

export interface AccountDialogProps {
  mode: "add" | "edit";
  account?: Account;
  open: boolean;
  onClose: () => void;
  onSave: (payload: AccountDialogSavePayload) => void;
}

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

const ENGINE_DEFAULTS: Record<
  AccountEngine,
  { permission: string; effort: string }
> = {
  claude: { permission: "acceptEdits", effort: "high" },
  codex: { permission: "workspace-edit", effort: "medium" },
};

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

  const [expectedEmail, setExpectedEmail] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  const [model, setModel] = useState("");
  const [effort, setEffort] = useState(ENGINE_DEFAULTS.claude.effort);
  const [permission, setPermission] = useState(ENGINE_DEFAULTS.claude.permission);

  const showSignInBrowser = platform.isDesktop && engine === "claude";
  const [signInBrowser, setSignInBrowserChoice] = useState("");
  const [browsers, setBrowsers] = useState<BrowserInfo[]>([]);

  const [showIconPicker, setShowIconPicker] = useState(false);
  const [showCodexSignIn, setShowCodexSignIn] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && account) {
      setName(account.name);
      setConfigDir(account.config_dir);
      setEngine(account.engine);
      setSubscriptionLabel(account.subscription_label ?? "");
      setHasCost(account.has_cost);
      setExpectedEmail(account.expected_email ?? "");
      setColor(account.color ?? "#3b82f6");
      setIcon(account.icon ?? "user");
      const sd = account.session_defaults ?? {};
      setModel(sd.model ?? "");
      setEffort(sd.effort ?? ENGINE_DEFAULTS[account.engine].effort);
      setPermission(sd.permissionMode ?? ENGINE_DEFAULTS[account.engine].permission);
    } else {
      setName("");
      setConfigDir("");
      setEngine("claude");
      setSubscriptionLabel("");
      setHasCost(true);
      setExpectedEmail("");
      setColor("#3b82f6");
      setIcon("user");
      setModel("");
      setEffort(ENGINE_DEFAULTS.claude.effort);
      setPermission(ENGINE_DEFAULTS.claude.permission);
    }
  }, [open, mode, account]);

  useEffect(() => {
    if (!open || !showSignInBrowser) return;
    let cancelled = false;
    setSignInBrowserChoice("");
    platform.listBrowsers().then((list) => { if (!cancelled) setBrowsers(list); }, () => {});
    const dir = mode === "edit" ? account?.config_dir : undefined;
    if (dir) {
      void getSignInBrowser(dir).then((id) => { if (!cancelled) setSignInBrowserChoice(id ?? ""); });
    }
    return () => { cancelled = true; };
  }, [open, mode, account, showSignInBrowser]);

  useEffect(() => {
    if (mode !== "add") return;
    setEffort(ENGINE_DEFAULTS[engine].effort);
    setPermission(ENGINE_DEFAULTS[engine].permission);
  }, [engine, mode]);

  const codexAuth = useCodexAuthStatus(
    engine === "codex" && mode === "edit" ? configDir : null,
  );

  const handleSave = (): void => {
    if (showSignInBrowser && configDir) {
      setSignInBrowser(configDir, signInBrowser || null).catch((err: unknown) => {
        console.error("[AccountDialog] saving the sign-in browser failed:", err);
      });
    }
    onSave({
      name,
      configDir,
      engine,
      subscriptionLabel,
      hasCost,
      color,
      icon,
      expectedEmail: expectedEmail.trim() || null,
      sessionDefaults: {
        model: model || undefined,
        effort: (effort || undefined) as SessionDefaults["effort"],
        permissionMode: permission,
      },
    });
  };

  // The spawning probe, not the cheap file read: this is an explicit one-off action.
  const handleDetect = (): void => {
    if (!configDir) return;
    setDetecting(true);
    setDetectError(null);
    void api
      .probeAccountAuthStatus(configDir)
      .then((status) => {
        if (status?.email) setExpectedEmail(status.email);
        else setDetectError("No signed-in account found in this config dir.");
      })
      .catch(() => {
        setDetectError("Couldn't reach the Claude CLI.");
      })
      .finally(() => {
        setDetecting(false);
      });
  };

  const handleSignOut = (): void => {
    void api.codexLogout(configDir).catch((err: unknown) => {
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

          {engine === "claude" && (
            <div className="space-y-1">
              <label htmlFor="account-email" className="text-xs text-muted-foreground">
                Email
              </label>
              <div className="flex gap-2">
                <Input
                  id="account-email"
                  placeholder="you@example.com"
                  value={expectedEmail}
                  onChange={(e) => { setExpectedEmail(e.target.value); }}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0"
                  onClick={handleDetect}
                  disabled={detecting || !configDir}
                >
                  {detecting ? "Detecting…" : "Detect"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {detectError ??
                  "Sessions warn if this config dir is signed in as someone else. Leave blank to skip the check."}
              </p>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Has cost"
              checked={hasCost}
              onChange={(e) => { setHasCost(e.target.checked); }}
            />
            Has cost
          </label>

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

          {showSignInBrowser && (
            <div className="space-y-1">
              <label htmlFor="account-sign-in-browser" className="text-xs text-muted-foreground">
                Sign-in browser
              </label>
              <select
                id="account-sign-in-browser"
                value={signInBrowser}
                onChange={(e) => { setSignInBrowserChoice(e.target.value); }}
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
              >
                <option value="">Default browser</option>
                {browsers.map((b) => (
                  <option key={b.bundleId} value={b.bundleId}>{b.name}</option>
                ))}
                {signInBrowser && !browsers.some((b) => b.bundleId === signInBrowser) && browsers.length > 0 && (
                  <option value={signInBrowser}>{`${signInBrowser} (not installed)`}</option>
                )}
              </select>
              <p className="text-[11px] text-muted-foreground">
                Claude and MCP sign-in pages for this account open here — pick the browser it is signed in with.
              </p>
            </div>
          )}

          <SessionDefaultsRow
            engine={engine}
            model={model}
            setModel={setModel}
            effort={effort}
            setEffort={setEffort}
            permissionMode={permission}
            setPermissionMode={setPermission}
            configDir={configDir || undefined}
          />

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
