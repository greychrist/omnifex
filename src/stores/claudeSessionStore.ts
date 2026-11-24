import { useMemo } from 'react';
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import type { JsonlNode } from '@/types/jsonl';
import {
  EMPTY_TOOL_PROGRESS,
  pruneToolProgress,
  reduceToolProgress,
  type ToolProgressMap,
  type ToolProgressNode,
} from '@/lib/toolProgress';
import {
  EMPTY_PERMISSION_CHECKS,
  reducePermissionCheck,
  type PermissionCheckFrame,
  type PermissionChecks,
} from '@/lib/permissionChecks';
import { appendCliRecord, reconcilePendingPrompt } from '@/lib/promptReconciliation';
import { deriveSessionTitle } from '@/lib/sessionTitle';
import type {
  SessionAccountInfo,
  SessionContextUsage,
  SessionModelInfo,
} from '@/lib/api';

export interface TabSessionState {
  messages: JsonlNode[];
  claudeSessionId: string | null;
  extractedSessionInfo: { sessionId: string; projectId: string } | null;
  sdkAccountInfo: SessionAccountInfo | null;
  contextUsage: SessionContextUsage | null;
  supportedModels: SessionModelInfo[];
  inflightAssistant: {
    uuid: string;
    text: string;
    parentToolUseId: string | null;
  } | null;
  inflightThinking: string | null;
  /** Live-only: the CLI never writes `tool_progress` to disk, so a reloaded transcript must not show it. */
  toolProgress: ToolProgressMap;
  permissionChecks: PermissionChecks;
}

export const EMPTY_TAB_SESSION: TabSessionState = {
  messages: [],
  claudeSessionId: null,
  extractedSessionInfo: null,
  sdkAccountInfo: null,
  contextUsage: null,
  supportedModels: [],
  inflightAssistant: null,
  inflightThinking: null,
  toolProgress: EMPTY_TOOL_PROGRESS,
  permissionChecks: EMPTY_PERMISSION_CHECKS,
};

type MessagesUpdater =
  | JsonlNode[]
  | ((prev: JsonlNode[]) => JsonlNode[]);

interface ClaudeSessionStoreState {
  tabs: Record<string, TabSessionState>;

  selectTab(tabId: string): TabSessionState;

  patchTab(tabId: string, patch: Partial<TabSessionState>): void;
  setMessages(tabId: string, next: MessagesUpdater): void;
  appendMessage(tabId: string, msg: JsonlNode): void;
  /** One action, so the match and the write cannot straddle another append. */
  appendOrReconcilePrompt(tabId: string, msg: JsonlNode): void;
  /** A persisted record goes above any prompt echo sent after it: the turn's last record can arrive after the queued prompt. */
  appendCliRecord(tabId: string, msg: JsonlNode): void;
  insertMessageBeforeFirstUser(tabId: string, msg: JsonlNode): void;
  resetTab(tabId: string): void;
  setInflightAssistantText(
    tabId: string,
    uuid: string,
    text: string,
    parentToolUseId: string | null,
  ): void;
  clearInflightAssistant(tabId: string): void;
  setInflightThinkingText(tabId: string, text: string): void;
  clearInflightThinking(tabId: string): void;
  applyToolProgress(tabId: string, node: ToolProgressNode): void;
  pruneToolProgressFor(tabId: string, keepIds: Set<string>): void;
  applyPermissionCheck(tabId: string, frame: PermissionCheckFrame): void;
  /** `done` may never come for a call the turn was interrupted under. */
  clearPermissionChecks(tabId: string): void;

  /** Test-only. */
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
      { set((state) => ({
        tabs: {
          ...state.tabs,
          [tabId]: { ...ensureTab(state.tabs, tabId), ...patch },
        },
      })); },

    setInflightAssistantText: (tabId, uuid, text, parentToolUseId) =>
      { set((state) => {
        const existing = ensureTab(state.tabs, tabId);
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...existing,
              inflightAssistant: { uuid, text, parentToolUseId },
              // The turn is the session's axis (useSessionLifecycle), so a first delta must not clear the tab spinner.
            },
          },
        };
      }); },

    setInflightThinkingText: (tabId, text) =>
      { set((state) => {
        const existing = ensureTab(state.tabs, tabId);
        // The flush rewrites every buffered tab; an unchanged thought must not hand subscribers a new object.
        if (existing.inflightThinking === text) return state;
        return { tabs: { ...state.tabs, [tabId]: { ...existing, inflightThinking: text } } };
      }); },

    clearInflightThinking: (tabId) =>
      { set((state) => {
        const existing = state.tabs[tabId];
        if (existing?.inflightThinking == null) return state;
        return { tabs: { ...state.tabs, [tabId]: { ...existing, inflightThinking: null } } };
      }); },

    clearInflightAssistant: (tabId) =>
      { set((state) => {
        const existing = state.tabs[tabId];
        if (!existing) return state;
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...existing, inflightAssistant: null },
          },
        };
      }); },

    setMessages: (tabId, next) =>
      { set((state) => {
        const slice = ensureTab(state.tabs, tabId);
        const messages = typeof next === 'function' ? next(slice.messages) : next;
        return {
          tabs: { ...state.tabs, [tabId]: { ...slice, messages } },
        };
      }); },

    appendMessage: (tabId, msg) =>
      { set((state) => {
        const slice = ensureTab(state.tabs, tabId);
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...slice, messages: [...slice.messages, msg] },
          },
        };
      }); },

    appendOrReconcilePrompt: (tabId, msg) =>
      { set((state) => {
        const slice = ensureTab(state.tabs, tabId);
        const reconciled = reconcilePendingPrompt(slice.messages, msg);
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...slice,
              messages: reconciled ?? appendCliRecord(slice.messages, msg),
            },
          },
        };
      }); },

    appendCliRecord: (tabId, msg) =>
      { set((state) => {
        const slice = ensureTab(state.tabs, tabId);
        return {
          tabs: {
            ...state.tabs,
            [tabId]: { ...slice, messages: appendCliRecord(slice.messages, msg) },
          },
        };
      }); },

    insertMessageBeforeFirstUser: (tabId, msg) =>
      { set((state) => {
        const slice = ensureTab(state.tabs, tabId);
        const idx = slice.messages.findIndex((m) => m.kind === 'user');
        const messages =
          idx >= 0
            ? [...slice.messages.slice(0, idx), msg, ...slice.messages.slice(idx)]
            : [...slice.messages, msg];
        return {
          tabs: { ...state.tabs, [tabId]: { ...slice, messages } },
        };
      }); },

    // Bail on an unchanged reference: heartbeats and reconnect replays redeliver frames verbatim,
    // and a no-op set re-renders every mounted transcript.
    applyToolProgress: (tabId, node) =>
      { set((state) => {
        const slice = ensureTab(state.tabs, tabId);
        const toolProgress = reduceToolProgress(slice.toolProgress, node, Date.now());
        if (toolProgress === slice.toolProgress) return state;
        return { tabs: { ...state.tabs, [tabId]: { ...slice, toolProgress } } };
      }); },

    pruneToolProgressFor: (tabId, keepIds) =>
      { set((state) => {
        const slice = state.tabs[tabId];
        if (!slice) return state;
        const toolProgress = pruneToolProgress(slice.toolProgress, keepIds);
        if (toolProgress === slice.toolProgress) return state;
        return { tabs: { ...state.tabs, [tabId]: { ...slice, toolProgress } } };
      }); },

    applyPermissionCheck: (tabId, frame) =>
      { set((state) => {
        const slice = ensureTab(state.tabs, tabId);
        const permissionChecks = reducePermissionCheck(slice.permissionChecks, frame);
        if (permissionChecks === slice.permissionChecks) return state;
        return { tabs: { ...state.tabs, [tabId]: { ...slice, permissionChecks } } };
      }); },

    clearPermissionChecks: (tabId) =>
      { set((state) => {
        const slice = state.tabs[tabId];
        if (!slice || slice.permissionChecks.size === 0) return state;
        return { tabs: { ...state.tabs, [tabId]: { ...slice, permissionChecks: EMPTY_PERMISSION_CHECKS } } };
      }); },

    resetTab: (tabId) =>
      { set((state) => ({
        tabs: { ...state.tabs, [tabId]: { ...EMPTY_TAB_SESSION } },
      })); },

    __resetForTests: () => { set({ tabs: {} }); },
  })),
);

type Setter<T> = (next: T | ((prev: T) => T)) => void;

export interface UseTabSessionResult extends TabSessionState {
  setMessages: Setter<JsonlNode[]>;
  setClaudeSessionId: Setter<string | null>;
  setExtractedSessionInfo: Setter<TabSessionState['extractedSessionInfo']>;
  setSdkAccountInfo: Setter<SessionAccountInfo | null>;
  setContextUsage: Setter<SessionContextUsage | null>;
  setSupportedModels: Setter<SessionModelInfo[]>;
  appendMessage: (msg: JsonlNode) => void;
  insertMessageBeforeFirstUser: (msg: JsonlNode) => void;
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
        ? (next)(slice[key])
        : next;
    store.patchTab(tabId, { [key]: value });
  };
}

// Keyed by array identity: the selector re-runs on every store change, and rescanning every tab's transcript per frame is O(n).
const titleByMessages = new WeakMap<readonly JsonlNode[], string | null>();

/** Derived on read, not stored: four actions mutate `messages`, and a stored copy would drift. */
export function useTabSessionTitle(tabId: string): string | null {
  return useClaudeSessionStore((s) => {
    const messages = s.tabs[tabId]?.messages;
    if (!messages || messages.length === 0) return null;
    const cached = titleByMessages.get(messages);
    if (cached !== undefined) return cached;
    const title = deriveSessionTitle(messages);
    titleByMessages.set(messages, title);
    return title;
  });
}

export function useTabSession(tabId: string): UseTabSessionResult {
  const slice = useClaudeSessionStore(
    useShallow((s) => s.tabs[tabId] ?? EMPTY_TAB_SESSION),
  );
  const appendMessage = useClaudeSessionStore((s) => s.appendMessage);
  const insertBefore = useClaudeSessionStore(
    (s) => s.insertMessageBeforeFirstUser,
  );
  const resetTab = useClaudeSessionStore((s) => s.resetTab);

  // Stable per tabId (makeSetter reads getState() at call time), so consumers can list them as deps.
  const setters = useMemo(
    () => ({
      setMessages: makeSetter(tabId, 'messages'),
      setClaudeSessionId: makeSetter(tabId, 'claudeSessionId'),
      setExtractedSessionInfo: makeSetter(tabId, 'extractedSessionInfo'),
      setSdkAccountInfo: makeSetter(tabId, 'sdkAccountInfo'),
      setContextUsage: makeSetter(tabId, 'contextUsage'),
      setSupportedModels: makeSetter(tabId, 'supportedModels'),
      appendMessage: (msg: JsonlNode) => { appendMessage(tabId, msg); },
      insertMessageBeforeFirstUser: (msg: JsonlNode) => { insertBefore(tabId, msg); },
      resetTab: () => { resetTab(tabId); },
    }),
    [tabId, appendMessage, insertBefore, resetTab],
  );

  return {
    ...slice,
    ...setters,
  };
}
