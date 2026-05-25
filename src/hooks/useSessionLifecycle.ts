import { useRef, useEffect, useState } from "react";
import { api, type SessionMode, type SessionStatus, type ConversationStatus } from "@/lib/api";
import type { ClaudeStreamMessage } from "@/types/claudeStream";
import type { EffortLevel, ThinkingConfig } from "@/components/FloatingPromptInput";
import { logAndForget } from "@/lib/fireAndLog";

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
  setSdkAccountInfo: React.Dispatch<React.SetStateAction<import("@/lib/api").SessionAccountInfo | null>>;
  setSupportedModels: React.Dispatch<React.SetStateAction<import("@/lib/api").SessionModelInfo[]>>;
  setSupportedCommands: React.Dispatch<React.SetStateAction<import("@/lib/api").SessionSlashCommand[]>>;
  setContextUsage: React.Dispatch<React.SetStateAction<import("@/lib/api").SessionContextUsage | null>>;
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
  setSdkAccountInfo,
  setSupportedModels,
  setSupportedCommands,
  setContextUsage,
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

    const outputUnlisten = window.electronAPI.onEvent(
      `claude-output:${tabId}`,
      (...args: unknown[]) => { handleJsonlLine(args[0] as string | object); },
    );

    // Closure carriers (queue-operation enqueue with <task-notification>,
    // attachment queued_command with the same) that the SDK iterator
    // doesn't yield. The main-process JSONL tail surfaces them on this
    // separate channel so the renderer can apply them to the same message
    // array — `deriveSubagents` then folds them through `applyEvents`
    // identically to JSONL replay.
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

    unlistenRefs.current = [outputUnlisten, outputExtraUnlisten, errorUnlisten, completeUnlisten, statusUnlisten];
  };

  // Standard tool names — Claude Code's always-on tools. Merged with MCP
  // tool names in fetchInitInfo once the SDK reports MCP server status.
  const STANDARD_TOOLS = [
    "Task", "AskUserQuestion", "Bash", "CronCreate", "CronList", "Edit",
    "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree", "Glob",
    "Grep", "ListMcpResourcesTool", "LSP", "Monitor", "NotebookEdit",
    "NotebookRead", "Read", "ReadMcpResourceTool", "RemoteTrigger",
    "ScheduleWakeup", "SendMessage", "Skill",
    "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate",
    "TeamCreate", "TeamDelete", "TodoRead", "TodoWrite", "Toolbox", "WebFetch",
    "WebSearch", "Write",
  ];

  // Enrich the SDK's real `system:init` message with MCP tool names once
  // they're known. No-op if the real init hasn't arrived yet — we never
  // insert a synthetic placeholder, so an empty chat means the SDK hasn't
  // yielded init (see docs/session-lifecycle.md). Preserves session_id and
  // every other field on the real init; only the `tools` list changes.
  const enrichInitTools = (tools: string[]) => {
    setMessages((prev) => {
      const idx = prev.findIndex(
        (m) => m.type === "system" && (m as any).subtype === "init",
      );
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], tools } as any;
      return next;
    });
  };

  // SDK MCP server statuses we treat as terminal — once every server is in
  // one of these we stop re-polling. `pending` is the only non-terminal
  // status under SDK 0.3.x, which connects slow MCP servers in the
  // background; if we stopped on first response we'd miss tools from any
  // server still warming up.
  const TERMINAL_MCP_STATUSES: ReadonlySet<string> = new Set([
    "connected", "failed", "needs-auth", "disabled",
  ]);

  const computeMcpToolNames = (mcpServers: import("@/lib/api").SessionMcpServerStatus[]): string[] =>
    mcpServers
      .filter((s) => s.status === "connected")
      .flatMap((s) =>
        (s.tools || []).map(
          (t) => `mcp__${s.name.replace(/[^a-zA-Z0-9]/g, "_")}__${t.name}`,
        ),
      );

  // Fetch SDK-derived metadata (account info, supported models/commands, MCP
  // tool list, context usage) once the CLI subprocess is responsive on its
  // control channel. Claude Code's CLI doesn't answer control queries until
  // after it has processed a first stdin message, so this polls indefinitely
  // (bounded only by component unmount via isMountedRef). Flips the session
  // status badge from 'Starting…' to 'Active' the moment the first response
  // lands so the UI matches reality.
  const fetchInitInfo = async () => {
    // Phase 1: poll sessionAccountInfo until the control channel answers.
    let info: import("@/lib/api").SessionAccountInfo | null = null;
    while (isMountedRef.current && !info) {
      try {
        info = await Promise.race([
          api.sessionAccountInfo(tabId),
          new Promise<null>((resolve) => setTimeout(() => { resolve(null); }, 2000)),
        ]);
      } catch {
        /* subprocess not ready yet */
      }
      if (!info) {
        if (!isMountedRef.current) return;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!info) return;

    setSdkAccountInfo(info);
    // Status badge is owned by main process — no flip here. Just enrich.

    // Phase 2: fetch the one-shot enrichment data (models, commands,
    // context usage) once.
    const [models, ctxUsage, commands] = await Promise.all([
      api.sessionSupportedModels(tabId).catch(() => []),
      api.sessionContextUsage(tabId).catch(() => null),
      api.sessionSupportedCommands(tabId).catch((err: unknown) => {
        console.error('[fetchInitInfo] supportedCommands call failed:', err);
        return [];
      }),
    ]);
    if (models?.length) setSupportedModels(models);
    if (commands?.length) setSupportedCommands(commands);
    if (ctxUsage) setContextUsage(ctxUsage);

    // Phase 3: poll mcpServerStatus until every server reaches a terminal
    // state. Under SDK 0.3.x slow servers report `status: 'pending'` from
    // the first init response until they finish their background connect.
    // Each successful poll re-upserts the init message so freshly-connected
    // tools appear without waiting for the rest.
    while (isMountedRef.current) {
      let mcpServers: import("@/lib/api").SessionMcpServerStatus[] | null = null;
      try {
        mcpServers = await api.sessionMcpServerStatus(tabId);
      } catch {
        /* transient — keep polling */
      }
      if (mcpServers) {
        enrichInitTools([...STANDARD_TOOLS, ...computeMcpToolNames(mcpServers)]);
        if (mcpServers.every((s) => TERMINAL_MCP_STATUSES.has(s.status))) return;
      }
      if (!isMountedRef.current) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
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
    }).catch((err: unknown) => {
      console.warn('[rebindPersistentSession] sessionGetHealth failed:', err);
    });
    logAndForget('use-session-lifecycle:fetch-init-info', fetchInitInfo());
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
      );
      // No state flips here. Main process owns lifecycle status and emits
      // `session-status:<tabId>` events; ClaudeCodeSession subscribes.
      // GUID arrives via `system:init` on `claude-output:<tabId>` and
      // flows through the reducer to claudeSessionId.
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
    // persistentSessionRef was claimed synchronously above. Session status
    // is owned by the main process and flips to 'started' on the SDK's
    // first system:init. We deliberately do NOT render a placeholder init
    // here — an empty chat is the honest UI for "session not yet alive."
    // If the chat stays empty, the SDK iterator hasn't yielded init yet
    // (see docs/session-lifecycle.md).

    // Enrich the SDK's init message with MCP tools as soon as the
    // control channel starts responding.
    logAndForget('use-session-lifecycle:fetch-init-info', fetchInitInfo());
  };

  // Cleanup event listeners and track mount state
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;

      // Stop the persistent process if the tab is being closed mid-session
      if (tabId && persistentSessionRef.current) {
        api.stopSession(tabId).catch((err: unknown) => {
          console.error("Failed to stop session on unmount:", err);
        });
      }

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
