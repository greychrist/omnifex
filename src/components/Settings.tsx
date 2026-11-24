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
  onBack: () => void;
  className?: string;
}

export const Settings: React.FC<SettingsProps> = (props) => (
  <SaveStatusProvider>
    <SettingsContent {...props} />
  </SaveStatusProvider>
);

const SettingsContent: React.FC<SettingsProps> = ({
  className,
}) => {
  // Pure read: StrictMode double-invokes initializers, so consuming the seed here loses it.
  const [activeTab, setActiveTab] = useState<string>(readInitialSettingsTab);
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    const handler = () => {
      // Warm path: the mount effect ran before App seeded it.
      clearInitialSettingsTab();
      setActiveTab('log');
    };
    window.addEventListener('log:focus-error-view', handler);
    return () => { window.removeEventListener('log:focus-error-view', handler); };
  }, []);

  // Consume once mounted so the seed can't hijack a later open. Idempotent under StrictMode.
  useEffect(() => { clearInitialSettingsTab(); }, []);

  return (
    <div className={cn("h-full overflow-y-auto", className)}>
      <div className="max-w-6xl mx-auto flex flex-col h-full">
      <div className="flex-1 flex flex-col overflow-hidden p-6">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full flex flex-col flex-1 overflow-hidden">
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
              <SaveStatusBanner className="absolute left-1/2 top-full mt-2 -translate-x-1/2" />
            </div>

            <div className={activeTab === "log" ? "flex-1 flex flex-col min-h-0 overflow-hidden" : "flex-1 overflow-y-auto"}>

            <TabsContent value="accounts" className="space-y-6">
              <Card className="p-6">
                <AccountSettings />
              </Card>
            </TabsContent>

            <TabsContent value="appearance" className="space-y-6">
              <AppearanceSettings setToast={setToast} />
            </TabsContent>

            <TabsContent value="general" className="space-y-6">
              <GeneralSettings />
            </TabsContent>

            <TabsContent value="system_prompts" className="space-y-6">
              <Card className="p-6">
                <SystemPromptSettings />
              </Card>
            </TabsContent>

            <TabsContent value="storage">
              <StorageTab />
            </TabsContent>

            <TabsContent value="proxy">
              <ProxySettingsPanel setToast={setToast} />
            </TabsContent>

            <TabsContent value="rate_limits" className="space-y-6">
              <RateLimitsSettings
                setToast={setToast}
              />
              <Card className="p-6">
                <ModelPricingEditor />
              </Card>
            </TabsContent>

            <TabsContent value="log" className="flex-1 flex flex-col min-h-0">
              <LogTab />
            </TabsContent>
            </div>

          </Tabs>
        </div>
      </div>

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
