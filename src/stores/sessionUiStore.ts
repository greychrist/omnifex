import { create } from 'zustand';
import type { ViewMode } from '@/components/SessionViewToggle';

type SessionMode = 'sdk' | 'tui';

interface SessionUi {
  mode: SessionMode;
  modeDisabled: boolean;
  modeDisabledReason?: string;
  viewMode: ViewMode;
}

interface SessionUiState {
  /** Per-tab UI state. Only set for tabs that host a ClaudeCodeSession. */
  byTab: Record<string, SessionUi>;
  /** Per-tab handlers. Stored outside of byTab so they don't trigger re-renders
   *  on unrelated state changes. */
  handlers: Record<string, {
    onModeChange: (mode: SessionMode) => void;
    onViewModeChange: (mode: ViewMode) => void;
  }>;
  publish: (tabId: string, ui: SessionUi, handlers: {
    onModeChange: (mode: SessionMode) => void;
    onViewModeChange: (mode: ViewMode) => void;
  }) => void;
  clear: (tabId: string) => void;
}

export const useSessionUiStore = create<SessionUiState>((set) => ({
  byTab: {},
  handlers: {},
  publish: (tabId, ui, handlers) =>
    set((s) => ({
      byTab: { ...s.byTab, [tabId]: ui },
      handlers: { ...s.handlers, [tabId]: handlers },
    })),
  clear: (tabId) =>
    set((s) => {
      const nextByTab = { ...s.byTab };
      const nextHandlers = { ...s.handlers };
      delete nextByTab[tabId];
      delete nextHandlers[tabId];
      return { byTab: nextByTab, handlers: nextHandlers };
    }),
}));
