import { useRef, useEffect } from "react";
import { api, type Session } from "@/lib/api";
import type { ClaudeStreamMessage } from "@/components/AgentExecution";
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
  accountResolution: {
    account: { name: string; account_type: string; config_dir: string };
    match_type: string;
    match_detail: string;
  } | null;
  effectiveSession: Session | null;
  persistentSessionRef: React.MutableRefObject<boolean>;
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
  effectiveSession,
  persistentSessionRef,
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
    unlistenRefs.current.forEach((u) => u());
    unlistenRefs.current = [];

    const outputUnlisten = window.electronAPI.onEvent(
      `claude-output:${tabId}`,
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
        }
      },
    );

    unlistenRefs.current = [outputUnlisten, errorUnlisten, completeUnlisten];
  };

  // Fetch SDK-derived metadata (account info, supported models/commands, MCP
  // tool list, context usage) and synthesize an init message so the renderer
  // can render the session header even before the next stream event.
  const fetchInitInfo = async (retries = 8) => {
    for (let i = 0; i < retries; i++) {
      try {
        const info = await api.sessionAccountInfo(tabId);
        if (info) {
          setSdkAccountInfo(info);

          const [models, mcpServers, ctxUsage, commands] = await Promise.all([
            api.sessionSupportedModels(tabId).catch(() => []),
            api.sessionMcpServerStatus(tabId).catch(() => []),
            api.sessionContextUsage(tabId).catch(() => null),
            api.sessionSupportedCommands(tabId).catch((err) => {
              console.error('[fetchInitInfo] supportedCommands call failed:', err);
              return [];
            }),
          ]);
          if (models?.length) setSupportedModels(models);
          if (commands?.length) setSupportedCommands(commands);
          if (ctxUsage) setContextUsage(ctxUsage as any);

          const standardTools = [
            "Task",
            "AskUserQuestion",
            "Bash",
            "CronCreate",
            "CronList",
            "Edit",
            "EnterPlanMode",
            "EnterWorktree",
            "ExitPlanMode",
            "ExitWorktree",
            "Glob",
            "Grep",
            "ListMcpResourcesTool",
            "LSP",
            "Monitor",
            "NotebookEdit",
            "NotebookRead",
            "Read",
            "ReadMcpResourceTool",
            "RemoteTrigger",
            "ScheduleWakeup",
            "SendMessage",
            "Skill",
            "TaskOutput",
            "TaskStop",
            "TeamCreate",
            "TeamDelete",
            "TodoRead",
            "TodoWrite",
            "Toolbox",
            "WebFetch",
            "WebSearch",
            "Write",
          ];
          const mcpToolNames = (mcpServers || [])
            .filter((s: any) => s.status === "connected")
            .flatMap((s: any) =>
              (s.tools || []).map(
                (t: any) =>
                  `mcp__${s.name.replace(/[^a-zA-Z0-9]/g, "_")}__${t.name}`,
              ),
            );
          const allTools = [...standardTools, ...mcpToolNames];

          setMessages((prev) => {
            if (prev.some((m) => m.type === "system" && m.subtype === "init"))
              return prev;
            return [
              {
                type: "system" as const,
                subtype: "init",
                session_id: "",
                model: selectedModel,
                cwd: projectPath,
                tools: allTools,
              } as any,
              ...prev,
            ];
          });
          return;
        }
      } catch {
        /* subprocess not ready yet */
      }
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
    fetchInitInfo();
    return true;
  };

  const startPersistentSession = async (resumeId?: string) => {
    if (persistentSessionRef.current) return; // Already running

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
    persistentSessionRef.current = true;

    // Fetch session details immediately (don't wait for first prompt).
    fetchInitInfo();
  };

  // Cleanup event listeners and track mount state
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;

      // Stop the persistent process if the tab is being closed mid-session
      if (tabId && persistentSessionRef.current) {
        api.stopSession(tabId).catch((err) => {
          console.error("Failed to stop session on unmount:", err);
        });
      }

      // Clean up listeners
      unlistenRefs.current.forEach((unlisten) => unlisten());
      unlistenRefs.current = [];

      // Clear checkpoint manager when session ends
      if (effectiveSession) {
        api.clearCheckpointManager(effectiveSession.id).catch((err) => {
          console.error("Failed to clear checkpoint manager:", err);
        });
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- cleanup must only run on unmount

  return {
    unlistenRefs,
    isMountedRef,
    startPersistentSession,
    rebindPersistentSession,
  };
}
