import React, { useState, useEffect } from "react";
import { AccountSettings } from "@/components/AccountSettings";
import { motion, AnimatePresence } from "framer-motion";
import { Save, AlertCircle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import {
  api,
  type Account,
  type ClaudeSettings,
  type ClaudeInstallation,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Toast, ToastContainer } from "@/components/ui/toast";
import { StorageTab } from "./StorageTab";
import { LogTab } from "./LogTab";
import { SummaryPromptSettings } from "./settings-panels/SummaryPromptSettings";
import {
  GeneralSettings,
  AppearanceSettings,
  ProxySettingsPanel,
  RateLimitsSettings,
  type ToastState,
} from "./settings-panels";

interface SettingsProps {
  /**
   * Callback to go back to the main view
   */
  onBack: () => void;
  /**
   * Optional className for styling
   */
  className?: string;
}

/**
 * Comprehensive Settings UI for managing Claude Code settings.
 * Thin shell that owns shared state and delegates to per-tab panel components.
 *
 * The Permissions / Environment / Advanced / Hooks / Commands tabs were
 * removed in May 2026 — they edited per-account `~/.claude/settings.json`
 * fields that are now configured outside this dialog (in-session permission
 * prompts, project hook editor, slash-command manager, etc.). The
 * load/save flow here only touches the global Claude settings keys read
 * by the General and Proxy tabs.
 */
export const Settings: React.FC<SettingsProps> = ({
  className,
}) => {
  const [settings, setSettings] = useState<ClaudeSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("general");
  const [currentBinaryPath, setCurrentBinaryPath] = useState<string | null>(null);
  const [selectedInstallation, setSelectedInstallation] = useState<ClaudeInstallation | null>(null);
  const [binaryPathChanged, setBinaryPathChanged] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  // The Claude settings file is per-account (`<configDir>/settings.json`).
  // There is no notion of a default account, so the user must explicitly
  // pick which account's settings.json to edit. We load the list of
  // accounts on mount and the user picks one — we never silently fall back
  // to the first account or to ~/.claude. See CLAUDE.md "Multi-Account Rules".
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedConfigDir, setSelectedConfigDir] = useState<string | null>(null);

  // Proxy state
  const [proxySettingsChanged, setProxySettingsChanged] = useState(false);
  const saveProxySettings = React.useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    api.listAccounts()
      .then((accts) => {
        setAccounts(accts);
        if (accts.length === 1) {
          // A single account is unambiguous — no picker needed, just use it.
          // This is NOT a default-account fallback: with two or more accounts
          // the user must explicitly pick one (no `accts[0]` shortcut).
          setSelectedConfigDir(accts[0].config_dir);
        } else {
          // Either zero accounts (nothing to edit) or multiple (user picks).
          // Either way, don't auto-select — the picker / empty state handles it.
          setLoading(false);
          if (accts.length === 0) setSettings({});
        }
      })
      .catch((err) => {
        console.error("Failed to list accounts:", err);
        setLoading(false);
        setError("Failed to load accounts.");
      });
    loadClaudeBinaryPath();
  }, []);

  // Load Claude settings as soon as the user picks (or auto-picks for the
  // single-account case) a config dir.
  useEffect(() => {
    if (selectedConfigDir) loadSettings();
  }, [selectedConfigDir]);

  const loadClaudeBinaryPath = async () => {
    try {
      const path = await api.getClaudeBinaryPath();
      setCurrentBinaryPath(path);
    } catch (err) {
      console.error("Failed to load Claude binary path:", err);
    }
  };

  const loadSettings = async () => {
    if (!selectedConfigDir) return;
    try {
      setLoading(true);
      setError(null);
      const loadedSettings = await api.getClaudeSettings({ configDir: selectedConfigDir });

      if (!loadedSettings || typeof loadedSettings !== 'object') {
        console.warn("Loaded settings is not an object:", loadedSettings);
        setSettings({});
        return;
      }

      setSettings(loadedSettings);
    } catch (err) {
      console.error("Failed to load settings:", err);
      setError(`Failed to load settings for ${selectedConfigDir}.`);
      setSettings({});
    } finally {
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    if (!selectedConfigDir) return;
    try {
      setSaving(true);
      setError(null);
      setToast(null);

      await api.saveClaudeSettings(settings ?? {}, { configDir: selectedConfigDir });

      if (binaryPathChanged && selectedInstallation) {
        await api.setClaudeBinaryPath(selectedInstallation.path);
        setCurrentBinaryPath(selectedInstallation.path);
        setBinaryPathChanged(false);
      }

      if (proxySettingsChanged && saveProxySettings.current) {
        await saveProxySettings.current();
        setProxySettingsChanged(false);
      }

      setToast({ message: "Settings saved successfully!", type: "success" });
    } catch (err) {
      console.error("Failed to save settings:", err);
      setError("Failed to save settings.");
      setToast({ message: "Failed to save settings", type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const updateSetting = (key: string, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  // Tabs whose data is actually written by the top-of-page Save button.
  // Other tabs own their own save flow (or are read-only / live-updated)
  // and the top button doesn't touch their state — showing it there is
  // confusing and contributes to the "multiple save buttons on one
  // screen" problem.
  const TABS_USING_TOP_SAVE = new Set([
    'proxy',
  ]);
  const showTopSave = TABS_USING_TOP_SAVE.has(activeTab);

  const handleClaudeInstallationSelect = (installation: ClaudeInstallation) => {
    setSelectedInstallation(installation);
    setBinaryPathChanged(installation.path !== currentBinaryPath);
  };

  return (
    <div className={cn("h-full overflow-y-auto", className)}>
      <div className="max-w-6xl mx-auto flex flex-col h-full">
        {/* Header */}
        <div className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-heading-1">Settings</h1>
              <p className="mt-1 text-body-small text-muted-foreground">
                Configure Claude Code preferences
              </p>
            </div>
            {showTopSave && (
              <motion.div
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.15 }}
              >
                <Button
                  onClick={saveSettings}
                  disabled={saving || loading}
                  size="default"
                >
                  {saving ? (
                    <>
                      <Spinner className="mr-2" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="mr-2 h-4 w-4" />
                      Save Settings
                    </>
                  )}
                </Button>
              </motion.div>
            )}
          </div>
        </div>

      {/* Error message */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="mx-4 mt-4 p-3 rounded-lg bg-destructive/10 border border-destructive/50 flex items-center gap-2 text-body-small text-destructive"
          >
            <AlertCircle className="h-4 w-4" />
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Account selector for the Claude settings.json file the General /
          Proxy panels read & write. With multiple accounts the user picks
          explicitly — there is no default-account fallback. With zero
          accounts we surface an empty state pointing at Account Settings. */}
      {accounts.length > 1 && (
        <div className="mx-4 mt-4 flex items-center gap-2 text-body-small">
          <span className="text-muted-foreground">Editing Claude settings.json for:</span>
          <select
            className="rounded border border-input bg-background px-2 py-1 text-body-small"
            value={selectedConfigDir ?? ''}
            onChange={(e) => setSelectedConfigDir(e.target.value || null)}
          >
            <option value="" disabled>— pick an account —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.config_dir}>{a.name} ({a.config_dir})</option>
            ))}
          </select>
        </div>
      )}
      {accounts.length === 0 && (
        <div className="mx-4 mt-4 p-3 rounded-lg border border-dashed border-muted-foreground/40 text-body-small text-muted-foreground">
          No Claude accounts configured yet. Add one under the <strong>Accounts</strong> tab — there is no default-account fallback, so a few panels here can't load until at least one account exists.
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Spinner className="size-8 text-muted-foreground" />
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden p-6">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full flex flex-col flex-1 overflow-hidden">
            <TabsList className="flex w-full mb-6 h-auto p-1 shrink-0">
              <TabsTrigger value="general" className="flex-1 py-2 text-xs">General</TabsTrigger>
              <TabsTrigger value="appearance" className="flex-1 py-2 text-xs">Chats</TabsTrigger>
              <TabsTrigger value="accounts" className="flex-1 py-2 text-xs">Accounts</TabsTrigger>
              <TabsTrigger value="sessions" className="flex-1 py-2 text-xs">Session Summaries</TabsTrigger>
              <TabsTrigger value="storage" className="flex-1 py-2 text-xs">Storage</TabsTrigger>
              <TabsTrigger value="proxy" className="flex-1 py-2 text-xs">Proxy</TabsTrigger>
              <TabsTrigger value="rate_limits" className="flex-1 py-2 text-xs">Rate Limits</TabsTrigger>
              <TabsTrigger value="log" className="flex-1 py-2 text-xs">Log</TabsTrigger>
            </TabsList>

            <div className={activeTab === "log" ? "flex-1 flex flex-col min-h-0 overflow-hidden" : "flex-1 overflow-y-auto"}>

            {/* Account Settings */}
            <TabsContent value="accounts" className="space-y-6">
              <Card className="p-6">
                <AccountSettings />
              </Card>
            </TabsContent>

            {/* Appearance Settings */}
            <TabsContent value="appearance" className="space-y-6">
              <AppearanceSettings setToast={setToast} />
            </TabsContent>

            {/* General Settings */}
            <TabsContent value="general" className="space-y-6">
              <GeneralSettings
                settings={settings}
                updateSetting={updateSetting}
                setToast={setToast}
                currentBinaryPath={currentBinaryPath}
                binaryPathChanged={binaryPathChanged}
                onClaudeInstallationSelect={handleClaudeInstallationSelect}
              />
            </TabsContent>

            {/* Sessions Tab — per-session summary prompt template */}
            <TabsContent value="sessions" className="space-y-6">
              <Card className="p-6">
                <SummaryPromptSettings />
              </Card>
            </TabsContent>

            {/* Storage Tab */}
            <TabsContent value="storage">
              <StorageTab />
            </TabsContent>

            {/* Proxy Settings */}
            <TabsContent value="proxy">
              <ProxySettingsPanel
                setToast={setToast}
                onProxyChange={(hasChanges: boolean, save: () => Promise<void>) => {
                  setProxySettingsChanged(hasChanges);
                  saveProxySettings.current = save;
                }}
              />
            </TabsContent>

            {/* Rate Limits Settings */}
            <TabsContent value="rate_limits" className="space-y-6">
              <RateLimitsSettings
                settings={settings}
                updateSetting={updateSetting}
                setToast={setToast}
              />
            </TabsContent>

            {/* Log Tab */}
            <TabsContent value="log" className="flex-1 flex flex-col min-h-0">
              <LogTab />
            </TabsContent>
            </div>

          </Tabs>
        </div>
      )}
      </div>

      {/* Toast Notification */}
      <ToastContainer>
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </ToastContainer>


    </div>
  );
};
