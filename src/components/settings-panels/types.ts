export interface ToastState {
  message: string;
  type: 'success' | 'error';
}

export interface SettingsPanelProps {
  setToast: (toast: ToastState | null) => void;
}
