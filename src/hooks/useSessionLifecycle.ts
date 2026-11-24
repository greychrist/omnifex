import { useRef, useEffect, useState, useMemo } from "react";
import { api, type AgentKind, type SessionStatus, type TurnState } from "@/lib/api";
import type { JsonlNode } from "@/types/jsonl";
import type { EffortLevel } from "@/components/FloatingPromptInput";
import { conversationStatus as deriveConversationStatus, type ConversationStatus } from "@/lib/sessionDerivedState";

function isIgnorableStderr(msg: string): boolean {
  if (!msg) return false;
  return (
    msg.includes("no stdin data received in") ||
    msg.includes("proceeding without it")
  );
}

const IDLE_TURN: TurnState = { status: 'idle', since: null };

interface WithStatus { status: string }

interface UseSessionLifecycleArgs {
  tabId: string;
  projectPath: string;
  selectedModel: string;
  permissionMode: string;
  effort: EffortLevel;
  agent?: AgentKind;
  accountResolution: {
    account: { name: string; subscription_label: string; config_dir: string };
    match_type: string;
    match_detail: string;
  } | null;
  persistentSessionRef: React.RefObject<boolean>;
  hasPendingStart?: boolean;
  handleJsonlLine: (payload: string | object) => void;
  setMessages: React.Dispatch<React.SetStateAction<JsonlNode[]>>;
  onSessionInit: (sessionId: string) => void;
  /** A resume spawns from the daemon's persisted options, not the picker. */
  onLivePermissionMode?: (mode: string) => void;
  tasks: WithStatus[];
  subagents: WithStatus[];
}

interface UseSessionLifecycleReturn {
  unlistenRefs: React.RefObject<(() => void)[]>;
  isMountedRef: React.RefObject<boolean>;
  /** `options.permissionMode` overrides the picker: "Restart in Bypass" starts before it re-renders. */
  startPersistentSession: (resumeId?: string, options?: { permissionMode?: string }) => Promise<void>;
  /** The CLI allows Bypass mid-session only when launched in Bypass. */
  launchPermissionMode: string | null;
  rebindPersistentSession: () => Promise<boolean>;
  sessionStatus: SessionStatus;
  /** Mirrored from main, never inferred from the transcript: a resumed session is idle until the user sends. */
  turn: TurnState;
  /** Null unless `sessionStatus === 'started'`. */
  conversationStatus: ConversationStatus | null;
  /** For teardowns that dispose their listeners and so miss main's 'stopped'. `conversationStatus` is ignored. */
  resetStatus: (next: { sessionStatus: SessionStatus; conversationStatus: ConversationStatus | null }) => void;
}

export function useSessionLifecycle({
  tabId,
  projectPath,
  selectedModel,
  permissionMode,
  effort,
  agent,
  accountResolution,
  persistentSessionRef,
  hasPendingStart,
  handleJsonlLine,
  setMessages,
  onSessionInit,
  onLivePermissionMode,
  tasks,
  subagents,
}: UseSessionLifecycleArgs): UseSessionLifecycleReturn {
  const unlistenRefs = useRef<(() => void)[]>([]);
  const isMountedRef = useRef(true);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(
    () => hasPendingStart ? 'starting' : 'stopped',
  );
  const [turn, setTurn] = useState<TurnState>(IDLE_TURN);
  const [launchPermissionMode, setLaunchPermissionMode] = useState<string | null>(null);

  const resetStatus = (next: { sessionStatus: SessionStatus; conversationStatus: ConversationStatus | null }) => {
    setSessionStatus(next.sessionStatus);
    setTurn(IDLE_TURN);
  };

  const attachStreamListeners = () => {
    unlistenRefs.current.forEach((u) => { u(); });
    unlistenRefs.current = [];

    const outputUnlisten = window.electronAPI.onEvent(
      `agent-output:${tabId}`,
      (...args: unknown[]) => { handleJsonlLine(args[0] as string | object); },
    );

    // Closure carriers the stream-json output may not surface, from the JSONL tail.
    const outputExtraUnlisten = window.electronAPI.onEvent(
      `claude-output-extra:${tabId}`,
      (payload: unknown) => { handleJsonlLine(payload as string | object); },
    );

    const errorUnlisten = window.electronAPI.onEvent(
      `agent-error:${tabId}`,
      (payload: unknown) => {
        if (isIgnorableStderr(payload as string)) return;
        console.error("[ClaudeCodeSession] stderr:", payload);
      },
    );

    const completeUnlisten = window.electronAPI.onEvent(
      `agent-complete:${tabId}`,
      () => {
        if (isMountedRef.current) {
          setTurn(IDLE_TURN);
          persistentSessionRef.current = false;
        }
        unlistenRefs.current.forEach((u) => u());
        unlistenRefs.current = [];
      },
    );

    const statusUnlisten = window.electronAPI.onEvent(
      `session-status:${tabId}`,
      (...args: unknown[]) => {
        if (!isMountedRef.current) return;
        const payload = args[0] as {
          sessionStatus?: SessionStatus;
        } | undefined;
        if (!payload?.sessionStatus) return;
        setSessionStatus(payload.sessionStatus);
        // The idle turn rides a separate channel; a dead process is idle regardless.
        if (payload.sessionStatus === 'stopped' || payload.sessionStatus === 'error') setTurn(IDLE_TURN);
      },
    );

    const turnUnlisten = window.electronAPI.onEvent(
      `session-turn:${tabId}`,
      (...args: unknown[]) => {
        if (!isMountedRef.current) return;
        const payload = args[0] as TurnState | undefined;
        if (payload?.status !== 'idle' && payload?.status !== 'running') return;
        setTurn({ status: payload.status, since: payload.since ?? null });
      },
    );

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
      turnUnlisten,
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
    api.sessionGetHealth(tabId).then((health) => {
      if (!isMountedRef.current || !health.alive) return;
      setSessionStatus(health.sessionStatus);
      if (health.turn) setTurn(health.turn);
      if (health.sessionId) onSessionInit(health.sessionId);
      adoptLiveModes(health);
    }).catch((err: unknown) => {
      console.warn('[rebindPersistentSession] sessionGetHealth failed:', err);
    });
    return true;
  };

  const rebindRef = useRef(rebindPersistentSession);
  rebindRef.current = rebindPersistentSession;

  // Lives here, not in the shim: resuming without re-attaching listeners leaves an invisible CLI burning tokens.
  // Cleared first: no agent-complete arrived, so rebind would short-circuit on the stale handle.
  useEffect(() => {
    if (!window.__omnifexRemote?.client) return;
    return window.electronAPI.onEvent(`remote-session-died:${tabId}`, () => {
      if (!isMountedRef.current) return;
      persistentSessionRef.current = false;
      setTurn(IDLE_TURN);
      void rebindRef.current().catch((err: unknown) => {
        console.error('[remote-session-died] rebind failed:', err);
      });
    });
  }, [tabId]); // eslint-disable-line react-hooks/exhaustive-deps -- rebind is read through a ref; the rest are stable refs/setters

  const adoptLiveModes = (health: { launchPermissionMode?: string | null; permissionMode?: string | null }) => {
    if (health.launchPermissionMode !== undefined) setLaunchPermissionMode(health.launchPermissionMode);
    if (typeof health.permissionMode === 'string' && health.permissionMode) onLivePermissionMode?.(health.permissionMode);
  };

  const startPersistentSession = async (resumeId?: string, options?: { permissionMode?: string }) => {
    if (persistentSessionRef.current) return;
    // Claim the slot synchronously: a concurrent call (StrictMode, re-render) would spawn a duplicate CLI.
    persistentSessionRef.current = true;

    // Optimistic: main's own 'starting' can fire before the listeners attach.
    setSessionStatus('starting');
    setTurn(IDLE_TURN);
    attachStreamListeners();

    const mode = options?.permissionMode ?? permissionMode;
    setLaunchPermissionMode(mode);
    let configDir = accountResolution?.account.config_dir;
    if (!configDir && projectPath) {
      try {
        const pair = await api.resolveAccountForProject(projectPath);
        // Fall back to the other engine's slot; never a default account — main raises NoAccountError.
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
    // 'auto' passes through: the engine omits `--effort` for non-CLI levels.
    const sdkEffort = effort;
    // Tells main not to re-resolve the user's explicit account choice.
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
        manualAccountOverride,
        agent,
      );
      api.sessionGetHealth(tabId).then((health) => {
        if (isMountedRef.current && health.alive) adoptLiveModes(health);
      }).catch((err: unknown) => {
        console.warn('[startPersistentSession] sessionGetHealth failed:', err);
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[startPersistentSession] api.startSession failed:", err);
      persistentSessionRef.current = false;
      setSessionStatus('error');
      setTurn(IDLE_TURN);
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
      throw err;
    }
  };

  // Re-attach on every mount and never detach on unmount: StrictMode's unmount would strand
  // a live session with no listeners. Teardown belongs to tab close.
  useEffect(() => {
    isMountedRef.current = true;
    if (persistentSessionRef.current && unlistenRefs.current.length === 0) {
      attachStreamListeners();
    }
    return () => {
      isMountedRef.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount-only effect; tabId is stable per hook instance

  const derivedConversationStatus: ConversationStatus | null = useMemo(
    () => sessionStatus === 'started'
      ? deriveConversationStatus(turn.status === 'running', tasks, subagents)
      : null,
    [sessionStatus, turn.status, tasks, subagents],
  );

  return {
    unlistenRefs,
    isMountedRef,
    startPersistentSession,
    rebindPersistentSession,
    sessionStatus,
    turn,
    launchPermissionMode,
    conversationStatus: derivedConversationStatus,
    resetStatus,
  };
}
