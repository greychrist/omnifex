import { useRef, useEffect } from "react";
import { api } from "@/lib/api";
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
  accountResolution: {
    account: { name: string; account_type: string; config_dir: string };
    match_type: string;
    match_detail: string;
  } | null;
  persistentSessionRef: React.MutableRefObject<boolean>;
  /**
   * Header badge states. Split so the UI can distinguish "subprocess is up
   * but SDK control channel hasn't answered yet" (Starting…) from "SDK is
   * fully warm and metadata is populated" (Active). `setIsSessionStarting`
   * flips true as soon as api.startSession resolves; `setIsSessionActive`
   * flips true only once fetchInitInfo receives a real control-channel
   * response. Both flip false when the session ends.
   */
  setIsSessionStarting: React.Dispatch<React.SetStateAction<boolean>>;
  setIsSessionActive: React.Dispatch<React.SetStateAction<boolean>>;
  handleStreamMessage: (payload: string | ClaudeStreamMessage) => void;
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
}

export function useSessionLifecycle({
  tabId,
  projectPath,
  selectedModel,
  permissionMode,
  effort,
  thinkingConfig,
  accountResolution,
  persistentSessionRef,
  setIsSessionStarting,
  setIsSessionActive,
  handleStreamMessage,
  setIsLoading,
  setMessages,
  setSdkAccountInfo,
  setSupportedModels,
  setSupportedCommands,
  setContextUsage,
}: UseSessionLifecycleArgs): UseSessionLifecycleReturn {
  const unlistenRefs = useRef<(() => void)[]>([]);
  const isMountedRef = useRef(true);

  // Attach the tab-scoped event listeners. Idempotent: tears down any prior
  // listeners first. Used both for fresh-start and for rebind-after-reload.
  const attachStreamListeners = () => {
    unlistenRefs.current.forEach((u) => { u(); });
    unlistenRefs.current = [];

    const outputUnlisten = window.electronAPI.onEvent(
      `claude-output:${tabId}`,
      (payload: any) => {
        handleStreamMessage(payload);
      },
    );

    // Closure carriers (queue-operation enqueue with <task-notification>,
    // attachment queued_command with the same) that the SDK iterator
    // doesn't yield. The main-process JSONL tail surfaces them on this
    // separate channel so the renderer can apply them to the same message
    // array — `deriveSubagents` then folds them through `applyEvents`
    // identically to JSONL replay.
    const outputExtraUnlisten = window.electronAPI.onEvent(
      `claude-output-extra:${tabId}`,
      (payload: any) => {
        handleStreamMessage(payload);
      },
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
          setIsSessionStarting(false);
          setIsSessionActive(false);
        }
      },
    );

    unlistenRefs.current = [outputUnlisten, outputExtraUnlisten, errorUnlisten, completeUnlisten];
  };

  // Standard tool names — Claude Code's always-on tools. MCP tool names get
  // appended in fetchInitInfo once the SDK control channel responds.
  const STANDARD_TOOLS = [
    "Task", "AskUserQuestion", "Bash", "CronCreate", "CronList", "Edit",
    "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree", "Glob",
    "Grep", "ListMcpResourcesTool", "LSP", "Monitor", "NotebookEdit",
    "NotebookRead", "Read", "ReadMcpResourceTool", "RemoteTrigger",
    "ScheduleWakeup", "SendMessage", "Skill", "TaskOutput", "TaskStop",
    "TeamCreate", "TeamDelete", "TodoRead", "TodoWrite", "Toolbox", "WebFetch",
    "WebSearch", "Write",
  ];

  // Synthesize/update the synthetic system:init message. Called twice:
  //   1. Immediately after api.startSession resolves, with standard tools
  //      only — so the chat renders the session header right away instead
  //      of looking blank while the CLI subprocess warms up.
  //   2. From fetchInitInfo once the SDK control channel answers — merges
  //      in MCP tool names. Replaces the existing init message in-place
  //      instead of adding a second one.
  const upsertInitMessage = (tools: string[]) => {
    setMessages((prev) => {
      const idx = prev.findIndex(
        (m) => m.type === "system" && (m as any).subtype === "init",
      );
      const init = {
        type: "system" as const,
        subtype: "init",
        session_id: "",
        model: selectedModel,
        cwd: projectPath,
        tools,
      } as any;
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...init };
        return next;
      }
      return [init, ...prev];
    });
  };

  // Fetch SDK-derived metadata (account info, supported models/commands, MCP
  // tool list, context usage) once the CLI subprocess is responsive on its
  // control channel. Claude Code's CLI doesn't answer control queries until
  // after it has processed a first stdin message, so this polls indefinitely
  // (bounded only by component unmount via isMountedRef). Flips the session
  // status badge from 'Starting…' to 'Active' the moment the first response
  // lands so the UI matches reality.
  const fetchInitInfo = async () => {
    while (isMountedRef.current) {
      try {
        const info = await Promise.race([
          api.sessionAccountInfo(tabId),
          new Promise<null>((resolve) => setTimeout(() => { resolve(null); }, 2000)),
        ]);
        if (info) {
          setSdkAccountInfo(info);
          // Mirror the rebind path (setIsSessionStarting(false) +
          // setIsSessionActive(true)) — the session has answered, so it's no
          // longer "Starting…". Without this, downstream consumers that
          // distinguish starting vs. active (e.g. the tab status popover)
          // get stuck on "Starting…" forever.
          setIsSessionStarting(false);
          setIsSessionActive(true);

          const [models, mcpServers, ctxUsage, commands] = await Promise.all([
            api.sessionSupportedModels(tabId).catch(() => []),
            api.sessionMcpServerStatus(tabId).catch(() => []),
            api.sessionContextUsage(tabId).catch(() => null),
            api.sessionSupportedCommands(tabId).catch((err: unknown) => {
              console.error('[fetchInitInfo] supportedCommands call failed:', err);
              return [];
            }),
          ]);
          if (models?.length) setSupportedModels(models);
          if (commands?.length) setSupportedCommands(commands);
          if (ctxUsage) setContextUsage(ctxUsage);

          const mcpToolNames = (mcpServers || [])
            .filter((s: any) => s.status === "connected")
            .flatMap((s: any) =>
              (s.tools || []).map(
                (t: any) =>
                  `mcp__${s.name.replace(/[^a-zA-Z0-9]/g, "_")}__${t.name}`,
              ),
            );
          upsertInitMessage([...STANDARD_TOOLS, ...mcpToolNames]);
          return;
        }
      } catch {
        /* subprocess not ready yet */
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
    // A successful rebind means the main-process session was already fully
    // warm before the renderer reloaded — jump straight to 'Active'.
    setIsSessionStarting(false);
    setIsSessionActive(true);
    logAndForget('use-session-lifecycle:fetch-init-info', fetchInitInfo());
    return true;
  };

  const startPersistentSession = async (resumeId?: string) => {
    if (persistentSessionRef.current) return; // Already running

    // Show 'Starting…' badge immediately — the main-process session handle
    // doesn't exist yet but the user has kicked off a start.
    setIsSessionStarting(true);
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
      );
    } catch (err) {
      // Surface session-start failures to the user. The most common cause
      // is "no account resolved for this project path" (configDir is
      // null-checked in the main process, throws synchronously); without
      // this branch, the renderer's `.catch(console.error)` would swallow
      // the message and leave the user staring at a stuck "Starting…"
      // badge with no clue what went wrong.
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[startPersistentSession] api.startSession failed:", err);
      setIsSessionStarting(false);
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
    persistentSessionRef.current = true;
    // Intentionally NOT flipping isSessionActive here — fetchInitInfo flips
    // it once the SDK control channel actually answers, which matches what
    // the user sees in the MCP / account / tools panels.

    // Render a synthetic system:init right away so the chat header + tool
    // list appear immediately. The Claude Code CLI subprocess doesn't answer
    // control-channel queries (accountInfo, mcpServerStatus, supportedCommands)
    // until after it's processed a first stdin message, so without this the
    // chat would look blank until the user sends their first prompt.
    upsertInitMessage([...STANDARD_TOOLS]);

    // Enrich the init message with MCP tools + account info as soon as the
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
  };
}
