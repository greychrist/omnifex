import React from "react";
import { Card } from "@/components/ui/card";
import { ProxySettings } from "@/components/ProxySettings";
import type { ToastState } from "./types";

interface ProxySettingsPanelProps {
  setToast: (toast: ToastState | null) => void;
  onProxyChange: (hasChanges: boolean, save: () => Promise<void>) => void;
}

export const ProxySettingsPanel: React.FC<ProxySettingsPanelProps> = ({
  setToast,
  onProxyChange,
}) => {
  return (
    <Card className="p-6">
      <ProxySettings
        setToast={setToast}
        onChange={(hasChanges, _getSettings, save) => {
          onProxyChange(hasChanges, save);
        }}
      />
    </Card>
  );
};
