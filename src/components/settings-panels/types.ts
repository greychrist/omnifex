export interface ToastState {
  message: string;
  type: 'success' | 'error';
}

/**
 * Props shared by panel components. The Settings shell no longer owns a
 * `settings.json` load/save flow — the three Claude-side keys it used to
 * edit (`includeCoAuthoredBy`, `verbose`, `cleanupPeriodDays`) were removed
 * in May 2026 (deprecated, undocumented, and rarely-tuned respectively),
 * which also retired the per-account picker. Each panel now owns its own
 * persistence; the shell just brokers toasts.
 */
export interface SettingsPanelProps {
  setToast: (toast: ToastState | null) => void;
}
