import type { ClaudeSettings } from "@/lib/api";

export interface PermissionRule {
  id: string;
  value: string;
}

export interface EnvironmentVariable {
  id: string;
  key: string;
  value: string;
}

export interface ToastState {
  message: string;
  type: 'success' | 'error';
}

/**
 * Props shared by panel components that need access to settings state
 * managed by the Settings shell.
 */
export interface SettingsPanelProps {
  settings: ClaudeSettings | null;
  updateSetting: (key: string, value: any) => void;
  setToast: (toast: ToastState | null) => void;
}
