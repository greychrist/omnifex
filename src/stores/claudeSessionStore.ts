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
import { reconcilePendingPrompt } from '@/lib/promptReconciliation';
import { deriveSessionTitle } from '@/lib/sessionTitle';
import type {
  SessionAccountInfo,
  SessionContextUsage,
  SessionModelInfo,
} from '@/lib/api';

/**
 * Per-tab slice of session state derived from the CLI stream.
 *
 * Owned by `claudeSessionStore` (one entry per tabId). Stores the small
 * set of stream-derived fields that ClaudeCodeSession needs to share
 * with header components and that the stream reducer's effects write
 * into. Rendering-side derived state (filtered messages, compact items,
 * subagents) stays in the component as `useMemo`s over `messages`.
 */
export interface TabSessionState {
  messages: JsonlNode[];
  claudeSessionId: string | null;
  extractedSessionInfo: { sessionId: string; projectId: string } | null;
  sdkAccountInfo: SessionAccountInfo | null;
  contextUsage: SessionContextUsage | null;
  supportedModels: SessionModelInfo[];
  /** Text-streaming slot for partial messages. Populated by the
   *  inflight coalescer's RAF flush; cleared when the complete assistant
   *  message lands (matching uuid), on stream error, or on tab close. */
  inflightAssistant: {
    uuid: string;
    text: string;
    parentToolUseId: string | null;
  } | null;
  /** Live-only per-tool progress, keyed by the REAL tool_use id (see
   *  src/lib/toolProgress.ts). Never persisted and never part of
   *  `messages[]` — the CLI does not write `tool_progress` to disk, so a
   *  transcript reloaded from disk must not show what a live one showed.
   *  `resetTab` clears it, so clear/restart needs no separate handling. */
  toolProgress: ToolProgressMap;
}

export const EMPTY_TAB_SESSION: TabSessionState = {
  messages: [],
  claudeSessionId: null,
  extractedSessionInfo: null,
  sdkAccountInfo: null,
  contextUsage: null,
  supportedModels: [],
  inflightAssistant: null,
  toolProgress: EMPTY_TOOL_PROGRESS,
};

type MessagesUpdater =
  | JsonlNode[]
  | ((prev: JsonlNode[]) => JsonlNode[]);

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
  appendMessage(tabId: string, msg: JsonlNode): void;
  /** Append the CLI's own record of a user prompt, replacing the optimistic
   *  echo it is a copy of when one is still pending. One action rather than
   *  a read-then-write so the match and the write cannot straddle another
   *  append. See src/lib/promptReconciliation.ts. */
  appendOrReconcilePrompt(tabId: string, msg: JsonlNode): void;
  /** Splice a system:init message in before the first user message,
   *  fall back to push when there is no user yet. */
  insertMessageBeforeFirstUser(tabId: string, msg: JsonlNode): void;
  resetTab(tabId: string): void;
  setInflightAssistantText(
    tabId: string,
    uuid: string,
    text: string,
    parentToolUseId: string | null,
  ): void;
  clearInflightAssistant(tabId: string): void;
  /** Fold one live `tool_progress` frame into the tab's map. */
  applyToolProgress(tabId: string, node: ToolProgressNode): void;
  /** Drop progress for tools no longer of interest (empty set at turn end). */
  pruneToolProgressFor(tabId: string, keepIds: Set<string>): void;

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
              // The in-chat typing-dots spinner is suppressed independently
              // via `hasInflightAssistant` in AgentSession (so dots and bubble
              // never co-exist on screen). The turn itself is the session's
              // axis (useSessionLifecycle), so a first delta cannot clear the
              // tab spinner mid-turn — the bug the original 0.4.17
              // partial-messages implementation introduced.
            },
          },
        };
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
              messages: reconciled ?? [...slice.messages, msg],
            },
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

    // Both of these bail on an unchanged reference rather than always
    // writing: heartbeats repeat, and a remote client's reconnect replay can
    // redeliver a frame verbatim. A no-op set would re-render every mounted
    // transcript for a value that did not move.
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

    resetTab: (tabId) =>
      { set((state) => ({
        tabs: { ...state.tabs, [tabId]: { ...EMPTY_TAB_SESSION } },
      })); },

    __resetForTests: () => { set({ tabs: {} }); },
  })),
);

// ---------------------------------------------------------------------------
// React-side ergonomics
// ---------------------------------------------------------------------------

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

/**
 * Cache of "title for this exact messages array", keyed by array identity.
 *
 * `useTabSessionTitle` is a Zustand selector, so it re-runs on every store
 * change anywhere — a tool-progress frame in another tab included. Without
 * this the tab strip would rescan every open tab's full transcript on each
 * frame of a running turn. A WeakMap keyed on the array means the O(n) scan
 * happens once per actual change to that tab's messages, and every other call
 * is a lookup. The entry dies with the array.
 */
const titleByMessages = new WeakMap<readonly JsonlNode[], string | null>();

/**
 * The session's name for one tab — the CLI's `ai-title`, or a `custom-title`
 * if it has been renamed.
 *
 * Derived on read rather than stored beside `messages`: four separate actions
 * mutate that array, and a cached copy would be four chances to drift from
 * the transcript it claims to describe. The returned value is a string, so a
 * tab only re-renders when its name actually changes.
 */
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

  // Memoize the setters so their identity is stable across renders for a given
  // tabId. makeSetter reads `getState()` at call time, so a setter is a pure
  // function of tabId — safe to build once. Stable setters are what let
  // consumers (useSessionLifecycle, AgentSession effects) depend on them in
  // dependency arrays without churn, and remove the need for the stale-closure
  // ref shims that the unstable-setter version forced. The store actions
  // (appendMessage/insertBefore/resetTab) are stable Zustand references.
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
