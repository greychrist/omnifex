import { useRef, useEffect, useState, useMemo } from "react";
import { api, type AgentKind, type SessionMode, type SessionStatus } from "@/lib/api";
import type { JsonlNode } from "@/types/jsonl";
import type { EffortLevel, ThinkingConfig } from "@/components/FloatingPromptInput";
import { conversationStatus as deriveConversationStatus, type ConversationStatus } from "@/lib/sessionDerivedState";

/** Filter out noisy stderr messages that aren't real errors. */
function isIgnorableStderr(msg: string): boolean {
  if (!msg) return false;
  return (
    msg.includes("no stdin data received in") ||
    msg.includes("proceeding without it")
  );
}

/** Loose structural type — only `.status` is read by the derivation. */
type WithStatus = { status: string };

interface UseSessionLifecycleArgs {
  tabId: string;
  projectPath: string;
  selectedModel: string;
  permissionMode: string;
  effort: EffortLevel;
  thinkingConfig: ThinkingConfig;
  sessionStartMode?: SessionMode;
  /**
   * Which engine to launch. Optional for back-compat with older callers
   * that haven't been threaded yet; main process treats missing values as
   * `'claude'` (see engine-factory dispatch in `electron/services/sessions/`).
   */
  agent?: AgentKind;
  accountResolution: {
    account: { name: string; subscription_label: string; config_dir: string };
    match_type: string;
    match_detail: string;
  } | null;
  persistentSessionRef: React.MutableRefObject<boolean>;
  /**
   * If the component is mounting with a session to resume or a
   * preconfigured fresh start, pass `true` so the initial sessionStatus
   * is 'starting' instead of 'stopped'. Prevents a one-frame flash of
   * the empty-state form before the auto-start effect fires.
   */
  hasPendingStart?: boolean;
  handleJsonlLine: (payload: string | object) => void;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setMessages: React.Dispatch<React.SetStateAction<JsonlNode[]>>;
  /**
   * Called when the main process emits `session-init:<tabId>` — i.e. the
   * CLI subprocess has been spawned and a pinned sessionId is known. Fires
   * before any `agent-output:` message arrives, so the renderer can seed
   * claudeSessionId / extractedSessionInfo (and unlock UI gated on them)
   * without waiting for the CLI's eventual `system:init` stream message.
   */
  onSessionInit: (sessionId: string) => void;
  /**
   * Current renderer messages array. `JsonlNode[]` as of Task 6 (adapter
   * deleted, messages are now real JSONL nodes). The derivation reads
   * `kind`, `userKind`, and `raw.message.stop_reason` directly.
   */
  messages: JsonlNode[];
  /**
   * Active task list. Only `.status` is read — pass `TaskListEntry[]` or
   * any `{ status: string }[]` compatible slice. Used by
   * `sessionDerivedState.hasOpenTasks` to detect in-flight tasks.
   */
  tasks: WithStatus[];
  /**
   * Active subagent list. Only `.status` is read — pass the array from
   * `deriveSubagents()` directly. Used by
   * `sessionDerivedState.hasOpenSubagents` to detect running dispatches.
   */
  subagents: WithStatus[];
}

interface UseSessionLifecycleReturn {
  unlistenRefs: React.MutableRefObject<(() => void)[]>;
  isMountedRef: React.MutableRefObject<boolean>;
  startPersistentSession: (resumeId?: string) => Promise<void>;
  /**
   * Re-attach to an in-flight session in the main process (no CLI restart).
   * Returns true if a live session existed and was reclaimed, false otherwise.
   * Used after a renderer reload (Cmd+R) so prompts keep flowing.
   */
  rebindPersistentSession: () => Promise<boolean>;
  /**
   * Connection axis. Single source of truth, driven by the main process
   * via `session-status:<tabId>` events plus optimistic updates from
   * `startPersistentSession` (set to 'starting' before IPC). Defaults to
   * 'stopped' before any activity. See `docs/session-lifecycle.md`.
   */
  sessionStatus: SessionStatus;
  /**
   * Turn axis. Null whenever `sessionStatus !== 'started'`. Derived from
   * `messages`, `tasks`, and `subagents` via `sessionDerivedState.conversationStatus`
   * rather than read from the IPC payload. The `conversationStatus` field on
   * `session-status:<tabId>` events is discarded — main no longer emits it
   * (Task 3 removed it from the IPC contract).
   */
  conversationStatus: ConversationStatus | null;
  /**
   * Synchronous setter for callers that need to reset the connection axis
   * independent of a main-process event — e.g. the stop / clear /
   * reconnect handlers that tear down the event listeners themselves
   * and therefore won't receive main's eventual `'stopped'` event.
   * The `conversationStatus` field in the argument is accepted for
   * back-compat but ignored — the turn axis is now derived, not stored.
   * Prefer reacting to events over calling this directly.
   */
  resetStatus: (next: { sessionStatus: SessionStatus; conversationStatus: ConversationStatus | null }) => void;
}

export function useSessionLifecycle({
  tabId,
  projectPath,
  selectedModel,
  permissionMode,
  effort,
  thinkingConfig,
  sessionStartMode,
  agent,
  accountResolution,
  persistentSessionRef,
  hasPendingStart,
  handleJsonlLine,
  setIsLoading,
  setMessages,
  onSessionInit,
  messages,
  tasks,
  subagents,
}: UseSessionLifecycleArgs): UseSessionLifecycleReturn {
  const unlistenRefs = useRef<(() => void)[]>([]);
  const isMountedRef = useRef(true);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(
    () => hasPendingStart ? 'starting' : 'stopped',
  );

  // `conversationStatus` is now derived, not stored. The `conversationStatus`
  // field on `session-status:<tabId>` IPC events was removed from the IPC
  // contract in Task 3 (jsonl-as-rendered refactor).
  const resetStatus = (next: { sessionStatus: SessionStatus; conversationStatus: ConversationStatus | null }) => {
    // `next.conversationStatus` is accepted for back-compat but ignored —
    // the turn axis is now computed from messages/tasks/subagents.
    setSessionStatus(next.sessionStatus);
  };

  // Attach the tab-scoped event listeners. Idempotent: tears down any prior
  // listeners first. Used both for fresh-start and for rebind-after-reload.
  const attachStreamListeners = () => {
    unlistenRefs.current.forEach((u) => { u(); });
    unlistenRefs.current = [];

    const outputUnlisten = window.electronAPI.onEvent(
      `agent-output:${tabId}`,
      (...args: unknown[]) => { handleJsonlLine(args[0] as string | object); },
    );

    // Closure carriers (queue-operation enqueue with <task-notification>,
    // attachment queued_command with the same) that the CLI stream-json
    // output may not surface. The main-process JSONL tail surfaces them on
    // this separate channel so the renderer can apply them to the same
    // message array — `deriveSubagents` then folds them through
    // `applyEvents` identically to JSONL replay.
    const outputExtraUnlisten = window.electronAPI.onEvent(
      `claude-output-extra:${tabId}`,
      (payload: unknown) => { handleJsonlLine(payload as string | object); },
    );

    const errorUnlisten = window.electronAPI.onEvent(
      `agent-error:${tabId}`,
      (payload: any) => {
        if (isIgnorableStderr(payload)) return;
        console.error("[ClaudeCodeSession] stderr:", payload);
      },
    );

    // `agent-complete:<tabId>` is main's authoritative "this session is
    // done" signal — fires on user stop, session error, AND on tab close
    // (TabContext.removeTab → api.stopSession → main emits complete). It's
    // the right place to tear listeners down: no more events are coming on
    // this tab, so holding the IPC subscriptions just leaks. State setters
    // are gated on isMountedRef because the React tree may already be gone
    // by the time complete arrives (tab close races React unmount); the
    // listener teardown runs unconditionally because ipcRenderer.removeListener
    // is safe regardless of React state.
    const completeUnlisten = window.electronAPI.onEvent(
      `agent-complete:${tabId}`,
      () => {
        if (isMountedRef.current) {
          setIsLoading(false);
          persistentSessionRef.current = false;
          // Status flip is owned by main process — it emits a final
          // `session-status:<tabId>` with 'stopped' on clean close. The
          // listener below catches it (before we dispose it below).
        }
        // Dispose all listeners for this session. Safe to run even though we
        // are inside one of them — Node EventEmitter (and ipcRenderer) tolerate
        // removeListener mid-dispatch. The next startPersistentSession call
        // re-creates them via attachStreamListeners.
        unlistenRefs.current.forEach((u) => u());
        unlistenRefs.current = [];
      },
    );

    // Single source of truth for the connection-axis badge. Main process emits
    // `session-status:<tabId>` on every transition. The payload's
    // `conversationStatus` field is discarded here — the turn axis is now
    // derived from messages/tasks/subagents (Task 2). Task 3 removes the field
    // from the IPC contract. See docs/session-lifecycle.md.
    const statusUnlisten = window.electronAPI.onEvent(
      `session-status:${tabId}`,
      (...args: unknown[]) => {
        if (!isMountedRef.current) return;
        const payload = args[0] as {
          sessionStatus?: SessionStatus;
        } | undefined;
        if (!payload?.sessionStatus) return;
        setSessionStatus(payload.sessionStatus);
      },
    );

    // `session-init:<tabId>` carries the pinned sessionId the moment the
    // CLI subprocess is alive — before any stream message arrives. Lets
    // the component seed claudeSessionId / extractedSessionInfo and unlock
    // UI gated on them (mode toggle, model picker, persistence) without
    // waiting for the CLI's mid-first-turn `system:init`.
    const initUnlisten = window.electronAPI.onEvent(
      `session-init:${tabId}`,
      (...args: unknown[]) => {
        if (!isMountedRef.current) return;
        const payload = args[0] as { sessionId?: string } | undefined;
        if (payload?.sessionId) onSessionInit(payload.sessionId);
      },
    );

    unlistenRefs.current = [
      outputUnlisten,
      outputExtraUnlisten,
      errorUnlisten,
      completeUnlisten,
      statusUnlisten,
      initUnlisten,
    ];
  };

  const rebindPersistentSession = async (): Promise<boolean> => {
    if (persistentSessionRef.current) return true;
    let rebound = false;
    try {
      rebound = await api.sessionRebind(tabId);
    } catch (e) {
      console.error("[rebindPersistentSession] sessionRebind failed:", e);
      return false;
    }
    if (!rebound) return false;
    attachStreamListeners();
    persistentSessionRef.current = true;
    // Seed both status axes from the live main-process handle. The
    // renderer just reloaded, so we may have missed recent transitions.
    // After this, the `session-status:<tabId>` listener catches any
    // subsequent change. Best-effort — leave status as-is on failure.
    api.sessionGetHealth(tabId).then((health) => {
      if (!isMountedRef.current || !health.alive) return;
      setSessionStatus(health.sessionStatus);
      // conversationStatus is now derived from messages/tasks/subagents — no
      // need to seed it from health. The turn axis auto-updates as messages flow.
      // Re-seed claudeSessionId on rebind — the renderer just reloaded and
      // may have lost it. The main process still holds the pinned id.
      if (health.sessionId) onSessionInit(health.sessionId);
    }).catch((err: unknown) => {
      console.warn('[rebindPersistentSession] sessionGetHealth failed:', err);
    });
    return true;
  };

  const startPersistentSession = async (resumeId?: string) => {
    if (persistentSessionRef.current) return; // Already running
    // Claim the slot synchronously — `api.startSession` awaits IPC and
    // account resolution, so a second concurrent call that hits the guard
    // above before this one's promise resolves would otherwise also fire
    // `startSession`, spawning a duplicate CLI query with a fresh UUID
    // and leaking the first one. React StrictMode double-mount and rapid
    // re-renders both trigger this. The error branch below resets the
    // ref so a failed start doesn't permanently lock out the tab.
    persistentSessionRef.current = true;

    // Show 'Starting…' badge immediately. Main process emits its own
    // `session-status: starting` event once `start()` runs, but that may
    // fire before the listener below has attached — set it eagerly so the
    // UI reflects the user's action regardless. Subsequent main-process
    // events overwrite this. conversationStatus derives to null per invariant
    // (sessionStatus !== 'started').
    setSessionStatus('starting');
    attachStreamListeners();

    // Resolve account fresh at session start (the cached state may not be ready yet)
    const mode = permissionMode;
    let configDir = accountResolution?.account.config_dir;
    if (!configDir && projectPath) {
      try {
        const pair = await api.resolveAccountForProject(projectPath);
        // Prefer the slot for this session's engine; fall back to the other
        // engine's slot so a session still resolves a configDir when only one
        // side routes here. No default-account fallback — an all-null pair
        // leaves configDir undefined and main raises NoAccountError.
        const account =
          (agent ? pair[agent]?.account : undefined)
          ?? pair.claude?.account
          ?? pair.codex?.account;
        if (account) {
          configDir = account.config_dir;
        }
      } catch (e) {
        console.error("[startPersistentSession] resolve error:", e);
      }
    }
    // Effort is always a CLI-supported level now (low/medium/high/xhigh/max) —
    // no more 'auto' sentinel that needed stripping.
    const sdkEffort = effort;
    const sdkThinking =
      thinkingConfig === "adaptive"
        ? { type: "adaptive" as const }
        : thinkingConfig === "disabled"
          ? { type: "disabled" as const }
          : { type: "enabled" as const, budgetTokens: 10000 };
    // Signal "user explicitly picked this account on the form" so main
    // doesn't re-resolve and overwrite their choice. `manual_override`
    // is set by AccountPickerDialog → setProjectAccountResolution in
    // TabContent (and the equivalent in ClaudeCodeSession's in-session
    // account swap). Everything else (path_rule / override-from-DB) is
    // safe for main to re-resolve fresh.
    const manualAccountOverride =
      accountResolution?.match_type === 'manual_override';
    try {
      await api.startSession(
        tabId,
        projectPath,
        selectedModel,
        mode,
        resumeId,
        configDir,
        sdkEffort,
        sdkThinking,
        sessionStartMode,
        manualAccountOverride,
        agent,
      );
      // No state flips here. Main process owns lifecycle status and emits
      // `session-status:<tabId>` events; ClaudeCodeSession subscribes.
      // sessionId arrives via `session-init:<tabId>` the moment the
      // subprocess spawns, so claudeSessionId is seeded immediately.
    } catch (err) {
      // Surface session-start failures to the user. The most common cause
      // is "no account resolved for this project path" (configDir is
      // null-checked in the main process, throws synchronously); without
      // this branch, the renderer's `.catch(console.error)` would swallow
      // the message and leave the user staring at a stuck "Starting…"
      // badge with no clue what went wrong.
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[startPersistentSession] api.startSession failed:", err);
      // Release the slot we claimed above so the user can retry.
      persistentSessionRef.current = false;
      setSessionStatus('error');
      setIsLoading(false);
      setMessages((prev) => [
        ...prev,
        {
          kind: 'system',
          subtype: 'notification',
          raw: {
            type: 'system',
            subtype: 'notification',
            notification_type: 'error',
            title: 'Session Failed to Start',
            body: `Could not start session: ${errMsg.slice(0, 300)}`,
            sessionId: '',
          } as never,
          sessionId: '',
          receivedAt: new Date().toISOString(),
        } satisfies JsonlNode,
      ]);
      throw err; // Bubble so the caller's .catch logger still fires.
    }
    // persistentSessionRef was claimed synchronously above. The main
    // process emits `session-status: started/idle` and `session-init`
    // (with the pinned sessionId) the moment the CLI subprocess is alive,
    // so the badge and claudeSessionId both update without any renderer-
    // side polling. Account / models / commands flow through the reducer
    // when the CLI emits its real `system:init` mid-first-turn.
  };

  // Mount/unmount lifecycle.
  //
  // React StrictMode mounts → unmounts → re-mounts components on first
  // render. Our auto-start effect handles the first mount (fresh-start
  // attaches listeners), then the StrictMode unmount tears every listener
  // off, then the second mount sees persistentSessionRef=true and skips
  // startPersistentSession — leaving the tab with zero IPC listeners for
  // the rest of its life. Main keeps emitting claude-output / session-status
  // / session-init into the void.
  //
  // Two-part fix:
  //   1. On EVERY mount, if a session is already live (persistentRef=true)
  //      but listeners are empty, re-attach. Idempotent — attachStreamListeners
  //      tears down any existing listeners first.
  //   2. Keep listeners alive across unmount. The unmount runs synchronously
  //      before re-mount in StrictMode and before any IPC event from main
  //      reaches the renderer, so tearing them off here loses real events.
  //      Listeners are owned by the main-process session, not the React tree;
  //      cleanup belongs in tab-close (TabContext.removeTab) and app-quit
  //      (main.ts before-quit → sessionsService.stopAll).
  useEffect(() => {
    isMountedRef.current = true;
    if (persistentSessionRef.current && unlistenRefs.current.length === 0) {
      attachStreamListeners();
    }
    return () => {
      isMountedRef.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount-only effect; tabId is stable per hook instance

  // Derive conversationStatus from the current messages/tasks/subagents.
  // Null whenever sessionStatus !== 'started' — the turn axis is meaningless
  // without an active connection. The IPC payload's `conversationStatus` field
  // is intentionally discarded in the `session-status:` listener above.
  // messages is now JsonlNode[] directly — no shim needed (Task 6).
  const derivedConversationStatus: ConversationStatus | null = useMemo(
    () => sessionStatus === 'started'
      ? deriveConversationStatus(messages, tasks, subagents)
      : null,
    [sessionStatus, messages, tasks, subagents],
  );

  return {
    unlistenRefs,
    isMountedRef,
    startPersistentSession,
    rebindPersistentSession,
    sessionStatus,
    conversationStatus: derivedConversationStatus,
    resetStatus,
  };
}
