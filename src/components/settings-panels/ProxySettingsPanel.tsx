import React from "react";
import { Card } from "@/components/ui/card";
import { ProxySettings } from "@/components/ProxySettings";
import type { ToastState } from "./types";

interface ProxySettingsPanelProps {
  setToast: (toast: ToastState | null) => void;
}

export const ProxySettingsPanel: React.FC<ProxySettingsPanelProps> = ({ setToast }) => (
  <Card className="p-6">
    <ProxySettings setToast={setToast} />
  </Card>
);
