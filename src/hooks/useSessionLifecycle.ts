import { useRef, useEffect, useState } from "react";
import { api, type SessionMode, type SessionStatus, type ConversationStatus } from "@/lib/api";
import type { ClaudeStreamMessage } from "@/types/claudeStream";
import type { EffortLevel, ThinkingConfig } from "@/components/FloatingPromptInput";

/** Filter out noisy stderr messages that aren't real errors. */
function isIgnorableStderr(msg: string): boolean {
  if (!msg) return false;
  return (
    msg.includes("no stdin data received in") ||
    msg.includes("proceeding without it")
  );
}

interface UseSessionLifecycleArgs {
  tabId: string;
  projectPath: string;
  selectedModel: string;
  permissionMode: string;
  effort: EffortLevel;
  thinkingConfig: ThinkingConfig;
  sessionStartMode?: SessionMode;
  accountResolution: {
    account: { name: string; account_type: string; config_dir: string };
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
  setMessages: React.Dispatch<React.SetStateAction<ClaudeStreamMessage[]>>;
  /**
   * Called when the main process emits `session-init:<tabId>` — i.e. the
   * CLI subprocess has been spawned and a pinned sessionId is known. Fires
   * before any `claude-output:` message arrives, so the renderer can seed
   * claudeSessionId / extractedSessionInfo (and unlock UI gated on them)
   * without waiting for the CLI's eventual `system:init` stream message.
   */
  onSessionInit: (sessionId: string) => void;
}

interface UseSessionLifecycleReturn {
  unlistenRefs: React.MutableRefObject<(() => void)[]>;
  isMountedRef: React.MutableRefObject<boolean>;
  startPersistentSession: (resumeId?: string) => Promise<void>;
  /**
   * Re-attach to an in-flight session in the main process (no SDK restart).
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
   * Turn axis. Null whenever `sessionStatus !== 'started'`. Driven the
   * same way as `sessionStatus`.
   */
  conversationStatus: ConversationStatus | null;
  /**
   * Synchronous setter for callers that need to reset both axes
   * independent of a main-process event — e.g. the stop / clear /
   * reconnect handlers that tear down the event listeners themselves
   * and therefore won't receive main's eventual `'stopped'` event.
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
  accountResolution,
  persistentSessionRef,
  hasPendingStart,
  handleJsonlLine,
  setIsLoading,
  setMessages,
  onSessionInit,
}: UseSessionLifecycleArgs): UseSessionLifecycleReturn {
  const unlistenRefs = useRef<(() => void)[]>([]);
  const isMountedRef = useRef(true);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(
    () => hasPendingStart ? 'starting' : 'stopped',
  );
  // conversationStatus is null whenever sessionStatus !== 'started'.
  // The setStatus emitter on main enforces this; the listener below
  // preserves it on the renderer side.
  const [conversationStatus, setConversationStatus] = useState<ConversationStatus | null>(null);

  const resetStatus = (next: { sessionStatus: SessionStatus; conversationStatus: ConversationStatus | null }) => {
    setSessionStatus(next.sessionStatus);
    setConversationStatus(next.sessionStatus === 'started' ? next.conversationStatus : null);
  };

  // Attach the tab-scoped event listeners. Idempotent: tears down any prior
  // listeners first. Used both for fresh-start and for rebind-after-reload.
  const attachStreamListeners = () => {
    unlistenRefs.current.forEach((u) => { u(); });
    unlistenRefs.current = [];

    // eslint-disable-next-line no-console -- diagnostic during phase-a debug
    console.log('[DIAG attach]', tabId, 'channels=', [
      `claude-output:${tabId}`,
      `session-status:${tabId}`,
      `session-init:${tabId}`,
    ]);
    const outputUnlisten = window.electronAPI.onEvent(
      `claude-output:${tabId}`,
      (...args: unknown[]) => {
        // eslint-disable-next-line no-console -- diagnostic
        console.log('[DIAG recv claude-output]', tabId, (args[0] as any)?.type, (args[0] as any)?.subtype);
        handleJsonlLine(args[0] as string | object);
      },
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
      `claude-error:${tabId}`,
      (payload: any) => {
        if (isIgnorableStderr(payload)) return;
        console.error("[ClaudeCodeSession] stderr:", payload);
      },
    );

    const completeUnlisten = window.electronAPI.onEvent(
      `claude-complete:${tabId}`,
      () => {
        if (isMountedRef.current) {
          setIsLoading(false);
          persistentSessionRef.current = false;
          // Status flip is owned by main process — it emits a final
          // `session-status:<tabId>` with 'stopped' on clean close. The
          // listener below catches it.
        }
      },
    );

    // Single source of truth for the lifecycle badge. Main process emits
    // `session-status:<tabId>` on every transition along either axis.
    // The payload always carries both fields. See docs/session-lifecycle.md.
    const statusUnlisten = window.electronAPI.onEvent(
      `session-status:${tabId}`,
      (...args: unknown[]) => {
        // eslint-disable-next-line no-console -- diagnostic
        console.log('[DIAG recv session-status]', tabId, args[0]);
        if (!isMountedRef.current) return;
        const payload = args[0] as {
          sessionStatus?: SessionStatus;
          conversationStatus?: ConversationStatus | null;
        } | undefined;
        if (!payload?.sessionStatus) return;
        setSessionStatus(payload.sessionStatus);
        // Invariant: conversationStatus is null unless sessionStatus is 'started'.
        if (payload.sessionStatus !== 'started') {
          setConversationStatus(null);
        } else {
          setConversationStatus(payload.conversationStatus ?? null);
        }
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
        // eslint-disable-next-line no-console -- diagnostic
        console.log('[DIAG recv session-init]', tabId, args[0]);
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
      setConversationStatus(
        health.sessionStatus === 'started' ? health.conversationStatus : null,
      );
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
    // `startSession`, spawning a duplicate SDK query with a fresh UUID
    // and leaking the first one. React StrictMode double-mount and rapid
    // re-renders both trigger this. The error branch below resets the
    // ref so a failed start doesn't permanently lock out the tab.
    persistentSessionRef.current = true;

    // Show 'Starting…' badge immediately. Main process emits its own
    // `session-status: starting` event once `start()` runs, but that may
    // fire before the listener below has attached — set it eagerly so the
    // UI reflects the user's action regardless. Subsequent main-process
    // events overwrite this. conversationStatus stays null per invariant.
    setSessionStatus('starting');
    setConversationStatus(null);
    attachStreamListeners();

    // Resolve account fresh at session start (the cached state may not be ready yet)
    const mode = permissionMode;
    let configDir = accountResolution?.account.config_dir;
    if (!configDir && projectPath) {
      try {
        const resolved = await api.resolveAccountForProject(projectPath);
        if (resolved) {
          configDir = resolved.config_dir;
        }
      } catch (e) {
        console.error("[startPersistentSession] resolve error:", e);
      }
    }
    // Effort is always an SDK-supported level now (low/medium/high/xhigh/max) —
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
      setConversationStatus(null);
      setIsLoading(false);
      setMessages((prev) => [
        ...prev,
        {
          type: "system",
          subtype: "notification",
          notification_type: "error",
          title: "Session Failed to Start",
          body: `Could not start session: ${errMsg.slice(0, 300)}`,
        },
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

  // Cleanup event listeners and track mount state
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      // Note: api.stopSession is NOT called here. React unmount alone must
      // not tear down a main-process SDK session — Cmd+R reload, StrictMode
      // double-invoke, and tab-visibility flips all trigger unmounts but
      // should keep the live session so rebind can claim it. The only
      // intentional teardown happens on explicit tab close (see
      // TabContext.removeTab) and on app quit (see main.ts before-quit
      // → sessionsService.stopAll).

      // Clean up listeners
      unlistenRefs.current.forEach((unlisten) => { unlisten(); });
      unlistenRefs.current = [];
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- cleanup must only run on unmount

  return {
    unlistenRefs,
    isMountedRef,
    startPersistentSession,
    rebindPersistentSession,
    sessionStatus,
    conversationStatus,
    resetStatus,
  };
}
