import React, { useState, useEffect } from "react";
import { AccountSettings } from "@/components/AccountSettings";
import { motion, AnimatePresence } from "framer-motion";
import { Save, AlertCircle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import {
  api,
  type ClaudeSettings,
  type ClaudeInstallation,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Toast, ToastContainer } from "@/components/ui/toast";
import { StorageTab } from "./StorageTab";
import { LogTab } from "./LogTab";
import {
  GeneralSettings,
  PermissionsSettings,
  EnvironmentSettings,
  AdvancedSettings,
  HooksSettings,
  CommandsSettings,
  ProxySettingsPanel,
  type PermissionRule,
  type EnvironmentVariable,
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

  // Permission rules state
  const [allowRules, setAllowRules] = useState<PermissionRule[]>([]);
  const [denyRules, setDenyRules] = useState<PermissionRule[]>([]);

  // Environment variables state
  const [envVars, setEnvVars] = useState<EnvironmentVariable[]>([]);

  // Hooks state
  const [userHooksChanged, setUserHooksChanged] = useState(false);
  const getUserHooks = React.useRef<(() => any) | null>(null);

  // Proxy state
  const [proxySettingsChanged, setProxySettingsChanged] = useState(false);
  const saveProxySettings = React.useRef<(() => Promise<void>) | null>(null);

  // Account selector for account-specific settings tabs
  const [accounts, setAccounts] = useState<Array<{ id: number; name: string; config_dir: string; is_default: boolean }>>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);

  useEffect(() => {
    api.listAccounts().then((accts) => {
      setAccounts(accts);
      const defaultAcct = accts.find((a: any) => a.is_default) || accts[0];
      if (defaultAcct) setSelectedAccountId(defaultAcct.id);
    }).catch(console.error);
  }, []);

  // Load settings when selected account is ready (or changes)
  useEffect(() => {
    if (selectedAccountId != null) {
      loadSettings();
    }
  }, [selectedAccountId]);

  // Load binary path on mount (not account-dependent)
  useEffect(() => {
    loadClaudeBinaryPath();
  }, []);

  const loadClaudeBinaryPath = async () => {
    try {
      const path = await api.getClaudeBinaryPath();
      setCurrentBinaryPath(path);
    } catch (err) {
      console.error("Failed to load Claude binary path:", err);
    }
  };

  const getSelectedConfigDir = () => {
    if (selectedAccountId == null) return undefined;
    return accounts.find(a => a.id === selectedAccountId)?.config_dir;
  };

  const loadSettings = async () => {
    try {
      setLoading(true);
      setError(null);
      const configDir = getSelectedConfigDir();
      const loadedSettings = await api.getClaudeSettings(configDir ? { configDir } : undefined);

      if (!loadedSettings || typeof loadedSettings !== 'object') {
        console.warn("Loaded settings is not an object:", loadedSettings);
        setSettings({});
        return;
      }

      setSettings(loadedSettings);

      // The settings file has a nested "settings" key:
      // { settings: { permissions: {...}, env: {...}, ... } }
      const inner = (loadedSettings.settings ?? loadedSettings) as Record<string, unknown>;

      // Parse permissions
      const perms = inner.permissions as Record<string, unknown> | undefined;
      if (perms && typeof perms === 'object') {
        if (Array.isArray(perms.allow)) {
          setAllowRules(
            perms.allow.map((rule: string, index: number) => ({
              id: `allow-${index}`,
              value: rule,
            }))
          );
        }
        if (Array.isArray(perms.deny)) {
          setDenyRules(
            perms.deny.map((rule: string, index: number) => ({
              id: `deny-${index}`,
              value: rule,
            }))
          );
        }
      }

      // Parse environment variables
      const env = inner.env as Record<string, string> | undefined;
      if (env && typeof env === 'object' && !Array.isArray(env)) {
        setEnvVars(
          Object.entries(env).map(([key, value], index) => ({
            id: `env-${index}`,
            key,
            value: value as string,
          }))
        );
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
      setError("Failed to load settings. Please ensure ~/.claude directory exists.");
      setSettings({});
    } finally {
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    try {
      setSaving(true);
      setError(null);
      setToast(null);

      // Preserve the nested "settings" key structure that Claude's settings.json uses
      const existingInner = ((settings as any)?.settings ?? settings) as Record<string, unknown>;
      const updatedInner = {
        ...existingInner,
        permissions: {
          allow: allowRules.map(rule => rule.value).filter(v => v && String(v).trim()),
          deny: denyRules.map(rule => rule.value).filter(v => v && String(v).trim()),
        },
        env: envVars.reduce((acc, { key, value }) => {
          if (key && String(key).trim() && value && String(value).trim()) {
            acc[key] = String(value);
          }
          return acc;
        }, {} as Record<string, string>),
      };
      const updatedSettings: ClaudeSettings = (settings as any)?.settings
        ? { ...settings, settings: updatedInner }
        : updatedInner;

      const configDir = getSelectedConfigDir();
      await api.saveClaudeSettings(updatedSettings, configDir ? { configDir } : undefined);
      setSettings(updatedSettings);

      if (binaryPathChanged && selectedInstallation) {
        await api.setClaudeBinaryPath(selectedInstallation.path);
        setCurrentBinaryPath(selectedInstallation.path);
        setBinaryPathChanged(false);
      }

      if (userHooksChanged && getUserHooks.current) {
        const hooks = getUserHooks.current();
        await api.updateHooksConfig('user', hooks);
        setUserHooksChanged(false);
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
              <TabsTrigger value="accounts" className="flex-1 py-2 text-xs">Accounts</TabsTrigger>
              <TabsTrigger value="permissions" className="flex-1 py-2 text-xs">Permissions</TabsTrigger>
              <TabsTrigger value="environment" className="flex-1 py-2 text-xs">Environment</TabsTrigger>
              <TabsTrigger value="advanced" className="flex-1 py-2 text-xs">Advanced</TabsTrigger>
              <TabsTrigger value="hooks" className="flex-1 py-2 text-xs">Hooks</TabsTrigger>
              <TabsTrigger value="commands" className="flex-1 py-2 text-xs">Commands</TabsTrigger>
              <TabsTrigger value="storage" className="flex-1 py-2 text-xs">Storage</TabsTrigger>
              <TabsTrigger value="proxy" className="flex-1 py-2 text-xs">Proxy</TabsTrigger>
              <TabsTrigger value="log" className="flex-1 py-2 text-xs">Log</TabsTrigger>
            </TabsList>

            <div className={activeTab === "log" ? "flex-1 flex flex-col min-h-0 overflow-hidden" : "flex-1 overflow-y-auto"}>
            {/* Account selector for account-specific tabs */}
            {["environment", "advanced", "hooks", "commands", "permissions"].includes(activeTab) && accounts.length > 0 && (
              <div className="flex items-center gap-2 mb-4 p-3 rounded-lg border border-border/50 bg-muted/30">
                <Label className="text-xs text-foreground/60 whitespace-nowrap">Editing settings for:</Label>
                <select
                  value={selectedAccountId ?? ''}
                  onChange={(e) => setSelectedAccountId(Number(e.target.value))}
                  className="text-sm bg-background border border-border rounded px-2 py-1"
                >
                  {accounts.map((acct) => (
                    <option key={acct.id} value={acct.id}>
                      {acct.name} ({acct.config_dir})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Account Settings */}
            <TabsContent value="accounts" className="space-y-6 mt-6">
              <Card className="p-6">
                <AccountSettings />
              </Card>
            </TabsContent>

            {/* General Settings */}
            <TabsContent value="general" className="space-y-6 mt-6">
              <GeneralSettings
                settings={settings}
                updateSetting={updateSetting}
                setToast={setToast}
                currentBinaryPath={currentBinaryPath}
                binaryPathChanged={binaryPathChanged}
                onClaudeInstallationSelect={handleClaudeInstallationSelect}
              />
            </TabsContent>

            {/* Permissions Settings */}
            <TabsContent value="permissions" className="space-y-6">
              <PermissionsSettings
                allowRules={allowRules}
                denyRules={denyRules}
                setAllowRules={setAllowRules}
                setDenyRules={setDenyRules}
              />
            </TabsContent>

            {/* Environment Variables */}
            <TabsContent value="environment" className="space-y-6">
              <EnvironmentSettings
                envVars={envVars}
                setEnvVars={setEnvVars}
              />
            </TabsContent>

            {/* Advanced Settings */}
            <TabsContent value="advanced" className="space-y-6">
              <AdvancedSettings
                settings={settings}
                updateSetting={updateSetting}
              />
            </TabsContent>

            {/* Hooks Settings */}
            <TabsContent value="hooks" className="space-y-6">
              <HooksSettings
                activeTab={activeTab}
                onHooksChange={(hasChanges: boolean, getHooks: () => any) => {
                  setUserHooksChanged(hasChanges);
                  getUserHooks.current = getHooks;
                }}
              />
            </TabsContent>

            {/* Commands Tab */}
            <TabsContent value="commands">
              <CommandsSettings />
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
