import React, { useState, useEffect } from "react";
import { AccountSettings } from "@/components/AccountSettings";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { ModelPricingEditor } from "@/components/ModelPricingEditor";
import { cn } from "@/lib/utils";
import { Toast, ToastContainer } from "@/components/ui/toast";
import { StorageTab } from "./StorageTab";
import { LogTab } from "./LogTab";
import { SystemPromptSettings } from "./settings-panels/SystemPromptSettings";
import { clearInitialSettingsTab, readInitialSettingsTab } from '@/lib/settingsInitialTab';
import {
  GeneralSettings,
  AppearanceSettings,
  ProxySettingsPanel,
  RateLimitsSettings,
  type ToastState,
} from "./settings-panels";
import { SaveStatusProvider, SaveStatusBanner } from "./settings-panels/saveStatus";

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
 * Settings shell. Each tab owns its own persistence and saves as it changes;
 * the shell hosts the save indicator every tab reports to (see
 * settings-panels/saveStatus.tsx) and brokers toasts for one-off actions.
 * There is no Save button — the last one only rendered on the Proxy tab, so
 * the Claude installation picker on General, which also waited for it, could
 * not be saved from its own tab.
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
export const Settings: React.FC<SettingsProps> = (props) => (
  <SaveStatusProvider>
    <SettingsContent {...props} />
  </SaveStatusProvider>
);

const SettingsContent: React.FC<SettingsProps> = ({
  className,
}) => {
  // sessionStorage handoff from App.tsx's "View in Log" action. The read is
  // PURE: it used to clear the key here too, which React StrictMode breaks by
  // design — it invokes initializers twice, so the first call consumed the seed
  // and the second returned 'general'. "View in Log" then opened Settings on
  // General, and the `log:focus-error-view` event could not cover for it
  // because `Settings` is lazily loaded and had not mounted when it fired.
  // Consuming the seed is now an effect, below.
  const [activeTab, setActiveTab] = useState<string>(readInitialSettingsTab);
  const [toast, setToast] = useState<ToastState | null>(null);

  // App.tsx dispatches `log:focus-error-view` when the user clicks the
  // "View in Log" action on an error toast. Switch the inner tab to the
  // Log panel; LogTab handles the level-filter side of the same event.
  useEffect(() => {
    const handler = () => {
      // Also consumes the seed: on the warm path this component was already
      // mounted, so the mount effect above ran long before App seeded it.
      clearInitialSettingsTab();
      setActiveTab('log');
    };
    window.addEventListener('log:focus-error-view', handler);
    return () => { window.removeEventListener('log:focus-error-view', handler); };
  }, []);

  // Consume the seed once mounted, so it cannot hijack a later, unrelated open
  // of the Settings tab. Idempotent — StrictMode runs this twice.
  useEffect(() => { clearInitialSettingsTab(); }, []);

  return (
    <div className={cn("h-full overflow-y-auto", className)}>
      <div className="max-w-6xl mx-auto flex flex-col h-full">
      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden p-6">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full flex flex-col flex-1 overflow-hidden">
            {/* Tab strip, with the save banner hanging beneath it.
                The "Settings" h1 + caption above this row was removed —
                the Settings tab in the app chrome already labels the
                page, and the tab strip below conveys what's available.
                Reclaims ~100px of vertical space at the top. */}
            <div className="relative flex items-center gap-3 mb-6 shrink-0">
              <TabsList className="flex flex-1 h-auto p-1">
                <TabsTrigger value="general" className="flex-1 py-2 text-xs">General</TabsTrigger>
                <TabsTrigger value="appearance" className="flex-1 py-2 text-xs">Chats</TabsTrigger>
                <TabsTrigger value="accounts" className="flex-1 py-2 text-xs">Accounts</TabsTrigger>
                <TabsTrigger value="system_prompts" className="flex-1 py-2 text-xs">System Prompts</TabsTrigger>
                <TabsTrigger value="storage" className="flex-1 py-2 text-xs">Storage</TabsTrigger>
                <TabsTrigger value="proxy" className="flex-1 py-2 text-xs">Proxy</TabsTrigger>
                <TabsTrigger value="rate_limits" className="flex-1 py-2 text-xs">Rate Limits</TabsTrigger>
                <TabsTrigger value="log" className="flex-1 py-2 text-xs">Log</TabsTrigger>
              </TabsList>
              {/* Floats centred just under the tab strip, over the panel. */}
              <SaveStatusBanner className="absolute left-1/2 top-full mt-2 -translate-x-1/2" />
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
              <GeneralSettings />
            </TabsContent>

            {/* System Prompts Tab — every prompt OmniFex composes and sends
                on the user's behalf, one sub-tab each. */}
            <TabsContent value="system_prompts" className="space-y-6">
              <Card className="p-6">
                <SystemPromptSettings />
              </Card>
            </TabsContent>

            {/* Storage Tab */}
            <TabsContent value="storage">
              <StorageTab />
            </TabsContent>

            {/* Proxy Settings */}
            <TabsContent value="proxy">
              <ProxySettingsPanel setToast={setToast} />
            </TabsContent>

            {/* Rate Limits Settings */}
            <TabsContent value="rate_limits" className="space-y-6">
              <RateLimitsSettings
                setToast={setToast}
              />
              <Card className="p-6">
                <ModelPricingEditor />
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
