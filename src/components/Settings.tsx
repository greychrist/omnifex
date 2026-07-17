import React, { useState, useEffect } from "react";
import { AccountSettings } from "@/components/AccountSettings";
import { motion, AnimatePresence } from "framer-motion";
import { Save, AlertCircle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { PricingOverridesEditor } from "@/components/PricingOverridesEditor";
import { api, type ClaudeInstallation } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Toast, ToastContainer } from "@/components/ui/toast";
import { StorageTab } from "./StorageTab";
import { LogTab } from "./LogTab";
import { SummaryPromptSettings } from "./settings-panels/SummaryPromptSettings";
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";
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
 * Settings shell. Each tab owns its own persistence; the shell only
 * brokers toasts plus the Claude-binary-path / Proxy save that share
 * the top-of-page Save button.
 *
 * History (May 2026):
 * - Permissions / Environment / Advanced / Hooks / Commands tabs were
 *   removed — those Claude `settings.json` fields are now configured
 *   outside this dialog (in-session permission prompts, project hook
 *   editor, slash-command manager, etc.).
 * - The General-tab `includeCoAuthoredBy`, `verbose`, and
 *   `cleanupPeriodDays` toggles were removed (deprecated, undocumented,
 *   and rarely-tuned respectively), which retired the per-account
 *   `getClaudeSettings`/`saveClaudeSettings` flow and the per-account
 *   picker that used to scope it.
 */
export const Settings: React.FC<SettingsProps> = ({
  className,
}) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // sessionStorage handoff from App.tsx's "View in Log" action — read AND
  // clear on first render so a stale value from a prior toast can't sticky
  // the Settings tab onto Log on a subsequent unrelated open. The
  // `log:focus-error-view` window event covers the warm-mount case below.
  const [activeTab, setActiveTab] = useState<string>(() => {
    try {
      const seed = window.sessionStorage.getItem('omnifex:settings-initial-tab');
      if (seed) {
        window.sessionStorage.removeItem('omnifex:settings-initial-tab');
        return seed;
      }
    } catch { /* private mode etc — fall through to default */ }
    return 'general';
  });
  const [currentBinaryPath, setCurrentBinaryPath] = useState<string | null>(null);
  const [selectedInstallation, setSelectedInstallation] = useState<ClaudeInstallation | null>(null);
  const [binaryPathChanged, setBinaryPathChanged] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  // Proxy state
  const [proxySettingsChanged, setProxySettingsChanged] = useState(false);
  const saveProxySettings = React.useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    logAndForget('settings:load-claude-binary-path', loadClaudeBinaryPath());
  }, []);

  // App.tsx dispatches `log:focus-error-view` when the user clicks the
  // "View in Log" action on an error toast. Switch the inner tab to the
  // Log panel; LogTab handles the level-filter side of the same event.
  useEffect(() => {
    const handler = () => { setActiveTab('log'); };
    window.addEventListener('log:focus-error-view', handler);
    return () => { window.removeEventListener('log:focus-error-view', handler); };
  }, []);

  const loadClaudeBinaryPath = async () => {
    try {
      const path = await api.getClaudeBinaryPath();
      setCurrentBinaryPath(path);
    } catch (err) {
      console.error("Failed to load Claude binary path:", err);
    }
  };

  const saveSettings = async () => {
    try {
      setSaving(true);
      setError(null);
      setToast(null);

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
      <div className="flex-1 flex flex-col overflow-hidden p-6">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full flex flex-col flex-1 overflow-hidden">
            {/* Tab strip + conditional Save button on the right.
                The "Settings" h1 + caption above this row was removed —
                the Settings tab in the app chrome already labels the
                page, and the tab strip below conveys what's available.
                Reclaims ~100px of vertical space at the top. */}
            <div className="flex items-center gap-3 mb-6 shrink-0">
              <TabsList className="flex flex-1 h-auto p-1">
                <TabsTrigger value="general" className="flex-1 py-2 text-xs">General</TabsTrigger>
                <TabsTrigger value="appearance" className="flex-1 py-2 text-xs">Chats</TabsTrigger>
                <TabsTrigger value="accounts" className="flex-1 py-2 text-xs">Accounts</TabsTrigger>
                <TabsTrigger value="sessions" className="flex-1 py-2 text-xs">Session Summaries</TabsTrigger>
                <TabsTrigger value="storage" className="flex-1 py-2 text-xs">Storage</TabsTrigger>
                <TabsTrigger value="proxy" className="flex-1 py-2 text-xs">Proxy</TabsTrigger>
                <TabsTrigger value="rate_limits" className="flex-1 py-2 text-xs">Rate Limits</TabsTrigger>
                <TabsTrigger value="log" className="flex-1 py-2 text-xs">Log</TabsTrigger>
              </TabsList>
              {showTopSave && (
                <motion.div
                  whileTap={{ scale: 0.97 }}
                  transition={{ duration: 0.15 }}
                  className="shrink-0"
                >
                  <Button
                    onClick={fireAndLog('settings:click', saveSettings)}
                    disabled={saving}
                    size="sm"
                  >
                    {saving ? (
                      <>
                        <Spinner className="mr-2" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="mr-2 h-4 w-4" />
                        Save
                      </>
                    )}
                  </Button>
                </motion.div>
              )}
            </div>

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
                setToast={setToast}
              />
              <Card className="p-6">
                <PricingOverridesEditor />
              </Card>
            </TabsContent>

            {/* Log Tab */}
            <TabsContent value="log" className="flex-1 flex flex-col min-h-0">
              <LogTab />
            </TabsContent>
            </div>

          </Tabs>
        </div>
      </div>

      {/* Toast Notification */}
      <ToastContainer>
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => { setToast(null); }}
          />
        )}
      </ToastContainer>


    </div>
  );
};
