import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import type {
  SessionAccountInfo,
  SessionContextUsage,
  SessionModelInfo,
} from '@/lib/api';

/**
 * Per-tab slice of session state derived from the SDK stream.
 *
 * Owned by `claudeSessionStore` (one entry per tabId). Stores the small
 * set of stream-derived fields that ClaudeCodeSession needs to share
 * with header components and that the stream reducer's effects write
 * into. Rendering-side derived state (filtered messages, compact items,
 * subagents) stays in the component as `useMemo`s over `messages`.
 */
export interface TabSessionState {
  messages: ClaudeStreamMessage[];
  claudeSessionId: string | null;
  extractedSessionInfo: { sessionId: string; projectId: string } | null;
  sdkAccountInfo: SessionAccountInfo | null;
  contextUsage: SessionContextUsage | null;
  supportedModels: SessionModelInfo[];
  isLoading: boolean;
}

export const EMPTY_TAB_SESSION: TabSessionState = {
  messages: [],
  claudeSessionId: null,
  extractedSessionInfo: null,
  sdkAccountInfo: null,
  contextUsage: null,
  supportedModels: [],
  isLoading: false,
};

type MessagesUpdater =
  | ClaudeStreamMessage[]
  | ((prev: ClaudeStreamMessage[]) => ClaudeStreamMessage[]);

interface ClaudeSessionStoreState {
  tabs: Record<string, TabSessionState>;

  // Selectors -------------------------------------------------------------
  /** Read the slice for a tab; returns EMPTY_TAB_SESSION for unknown tabs.
   *  Use this from non-React call sites (e.g. the stream reducer's effect
   *  runner). React components should use `useTabSession`. */
  selectTab(tabId: string): TabSessionState;

  // Actions ---------------------------------------------------------------
  patchTab(tabId: string, patch: Partial<TabSessionState>): void;
  setMessages(tabId: string, next: MessagesUpdater): void;
  appendMessage(tabId: string, msg: ClaudeStreamMessage): void;
  /** Splice a system:init message in before the first user message,
   *  fall back to push when there is no user yet. */
  insertMessageBeforeFirstUser(tabId: string, msg: ClaudeStreamMessage): void;
  resetTab(tabId: string): void;

  /** Test-only — wipes the whole store. */
  __resetForTests(): void;
}

function ensureTab(
  tabs: Record<string, TabSessionState>,
  tabId: string,
): TabSessionState {
  return tabs[tabId] ?? EMPTY_TAB_SESSION;
}

export const useClaudeSessionStore = create<ClaudeSessionStoreState>()(
  subscribeWithSelector((set, get) => ({
    tabs: {},

    selectTab: (tabId) => ensureTab(get().tabs, tabId),

    patchTab: (tabId, patch) =>
      set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: { ...ensureTab(state.tabs, tabId), ...patch },
        },
      })),

    setMessages: (tabId, next) =>
      set((state) => {
        const slice = ensureTab(state.tabs, tabId);
        const messages = typeof next === 'function' ? next(slice.messages) : next;
        return {
          tabs: { ...state.tabs, [tabId]: { ...slice, messages } },
        };
      }),

    appendMessage: (tabId, msg) =>
      set((state) => {
        const slice = ensureTab(state.tabs, tabId);
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...slice, messages: [...slice.messages, msg] },
          },
        };
      }),

    insertMessageBeforeFirstUser: (tabId, msg) =>
      set((state) => {
        const slice = ensureTab(state.tabs, tabId);
        const idx = slice.messages.findIndex((m) => m.type === 'user');
        const messages =
          idx >= 0
            ? [...slice.messages.slice(0, idx), msg, ...slice.messages.slice(idx)]
            : [...slice.messages, msg];
        return {
          tabs: { ...state.tabs, [tabId]: { ...slice, messages } },
        };
      }),

    resetTab: (tabId) =>
      set((state) => ({
        tabs: { ...state.tabs, [tabId]: { ...EMPTY_TAB_SESSION } },
      })),

    __resetForTests: () => set({ tabs: {} }),
  })),
);

// ---------------------------------------------------------------------------
// React-side ergonomics
// ---------------------------------------------------------------------------

type Setter<T> = (next: T | ((prev: T) => T)) => void;

export interface UseTabSessionResult extends TabSessionState {
  setMessages: Setter<ClaudeStreamMessage[]>;
  setClaudeSessionId: Setter<string | null>;
  setExtractedSessionInfo: Setter<TabSessionState['extractedSessionInfo']>;
  setSdkAccountInfo: Setter<SessionAccountInfo | null>;
  setContextUsage: Setter<SessionContextUsage | null>;
  setSupportedModels: Setter<SessionModelInfo[]>;
  setIsLoading: Setter<boolean>;
  appendMessage: (msg: ClaudeStreamMessage) => void;
  insertMessageBeforeFirstUser: (msg: ClaudeStreamMessage) => void;
  resetTab: () => void;
}

function makeSetter<K extends keyof TabSessionState>(
  tabId: string,
  key: K,
): Setter<TabSessionState[K]> {
  return (next) => {
    const store = useClaudeSessionStore.getState();
    const slice = store.selectTab(tabId);
    const value =
      typeof next === 'function'
        ? (next as (prev: TabSessionState[K]) => TabSessionState[K])(slice[key])
        : next;
    store.patchTab(tabId, { [key]: value } as Partial<TabSessionState>);
  };
}

/**
 * React hook that returns the per-tab slice plus React-shaped setters.
 *
 * Setters match `Dispatch<SetStateAction<T>>` so they can be passed to
 * existing hooks (e.g. `useSessionLifecycle`) as drop-in replacements
 * for the old `useState` setters.
 */
export function useTabSession(tabId: string): UseTabSessionResult {
  const slice = useClaudeSessionStore(
    useShallow((s) => s.tabs[tabId] ?? EMPTY_TAB_SESSION),
  );
  const appendMessage = useClaudeSessionStore((s) => s.appendMessage);
  const insertBefore = useClaudeSessionStore(
    (s) => s.insertMessageBeforeFirstUser,
  );
  const resetTab = useClaudeSessionStore((s) => s.resetTab);

  return {
    ...slice,
    setMessages: makeSetter(tabId, 'messages'),
    setClaudeSessionId: makeSetter(tabId, 'claudeSessionId'),
    setExtractedSessionInfo: makeSetter(tabId, 'extractedSessionInfo'),
    setSdkAccountInfo: makeSetter(tabId, 'sdkAccountInfo'),
    setContextUsage: makeSetter(tabId, 'contextUsage'),
    setSupportedModels: makeSetter(tabId, 'supportedModels'),
    setIsLoading: makeSetter(tabId, 'isLoading'),
    appendMessage: (msg) => appendMessage(tabId, msg),
    insertMessageBeforeFirstUser: (msg) => insertBefore(tabId, msg),
    resetTab: () => resetTab(tabId),
  };
}
