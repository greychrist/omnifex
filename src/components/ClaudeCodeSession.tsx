import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Copy,
  ChevronDown,
  ChevronUp,
  X,
  Plug,
  Package,
  Shield,
  ArrowLeft,
  PanelRightOpen,
} from "lucide-react";
import { SessionInspectorPanel } from "@/components/SessionInspectorPanel";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { api, type Session, type RateLimitSnapshot, type Account, type SessionMode } from "@/lib/api";
import { cn } from "@/lib/utils";
import { NewSessionForm } from "./NewSessionForm";
import { AccountPickerDialog } from "./AccountPickerDialog";
import { StreamMessage } from "./StreamMessage";
import {
  FloatingPromptInput,
  type FloatingPromptInputRef,
  type EffortLevel,
  type ThinkingConfig,
} from "./FloatingPromptInput";
import { normalizeThinkingConfig } from "@/lib/thinkingConfig";
import { MODELS } from "./ModelPicker";
import { ErrorBoundary } from "./ErrorBoundary";
import { SlashCommandsManager } from "./SlashCommandsManager";
import { SessionMCPStatus } from "./SessionMCPStatus";
import { SessionPluginStatus } from "./SessionPluginStatus";
import { PermissionCard } from "./PermissionCard";
import { AskUserQuestionCard } from "./AskUserQuestionCard";
import { ElicitationDialog } from "./ElicitationDialog";
import { SessionPermissionsEditor } from "./SessionPermissionsEditor";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { TooltipProvider, TooltipSimple } from "@/components/ui/tooltip-modern";
import { SplitPane } from "@/components/ui/split-pane";
import { WebviewPreview } from "./WebviewPreview";
import type { ClaudeStreamMessage } from "@/types/claudeStream";
import { normalizeMessageContent } from "@/lib/normalizeMessage";
import { classifyJsonlLine } from '@/lib/jsonlClassifier';
import { createSynthesizer, synthesizeBatch } from '@/lib/jsonlSynthesizer';
import { jsonlNodeToStreamMessage } from '@/lib/jsonlAdapter';
import { reduceSessionStreamMessage } from '@/lib/sessionStreamReducer';
import { runStreamEffect } from '@/lib/sessionStreamEffects';
import { appendInflightDelta } from '@/lib/inflightCoalescer';
import { maybeAutoGenerateSummaryOnLeave } from "@/lib/sessionSummaryGate";
import { SessionModeToggle } from "./SessionModeToggle";
import { SessionViewToggle, type ViewMode } from "./SessionViewToggle";
import { TuiSessionLayout } from './TuiSessionLayout';
import { HiddenEventsGroup } from "./HiddenEventsGroup";
import { buildCompactItems } from "@/lib/compactGrouping";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { HeaderLabel } from "./HeaderLabel";
import { AccountCard } from "./AccountCard";
import { SessionCard } from "./SessionCard";
import { GitBranchBadge } from "./claude-code-session/GitBranchBadge";
import { GitWatchStatusIcon } from "./claude-code-session/GitWatchStatusIcon";
import { resolveBranchColors } from '@/lib/branchColors';
import type { BranchColor } from '@/lib/api';
import { filterDisplayableMessages } from "@/lib/messageFilters";
import { deriveSubagents, createSubagentColorAllocator } from "@/lib/subagentStreams";
import { getTaskList, summarizeTaskList } from "@/lib/taskList";
import { SubagentBar } from "./SubagentBar";
import { TaskList } from "./TaskList";
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";
import { decideAutoStart } from "@/lib/sessionAutoStart";
import { FindBar } from "./FindBar";
import { useFindInChat } from "@/hooks/useFindInChat";
import { exportAsJsonl, exportAsMarkdown } from "@/lib/sessionExporters";
import { usePermissions } from "@/hooks/usePermissions";
import { useSessionLifecycle } from "@/hooks/useSessionLifecycle";
import { useSendPrompt } from "@/hooks/useSendPrompt";
import { usePublishTabStatus } from "@/hooks/usePublishTabStatus";
import { useTabContext } from "@/contexts/TabContext";
// Virtualizer removed — flat list for reliable scrolling
import { SessionPersistenceService } from "@/services/sessionPersistence";
import { clearInflightBuffer } from "@/lib/inflightCoalescer";
import { InflightAssistantBubble } from "./InflightAssistantBubble";
import { useTabSession, useClaudeSessionStore } from "@/stores/claudeSessionStore";
import type { PermissionSuggestion } from "@/lib/types/permissionRequest";

// Random gerund words like Claude Code CLI — hoisted to module scope so
// pickGerund has a stable identity that effects/callbacks can list as a
// dep without recreating on every render.
const GERUNDS = [
  "Honking", "Pondering", "Musing", "Cogitating", "Ruminating", "Brewing",
  "Noodling", "Puzzling", "Tinkering", "Scheming", "Conjuring", "Percolating",
  "Deliberating", "Contemplating", "Hatching", "Weaving", "Forging", "Crafting",
  "Kneading", "Sifting", "Plotting", "Wrangling",
] as const;
const pickGerund = (): string => GERUNDS[Math.floor(Math.random() * GERUNDS.length)];

// User-resizable session header. Height persists across tabs/sessions via
// localStorage. When unset (null), the header sizes to its natural content
// (driven by the back button + the worktree column's default 5.25rem cap).
// Once the user drags the bottom edge, the inner worktree list flexes to fill
// the available vertical space instead of clamping to 3-and-a-peek.
const HEADER_HEIGHT_KEY = 'omnifex.session-header-height';
const MIN_HEADER_HEIGHT = 60;
const MAX_HEADER_HEIGHT = 600;

interface ClaudeCodeSessionProps {
  /**
   * Optional session to resume (when clicking from SessionList)
   */
  session?: Session;
  /**
   * Initial project path (for new sessions)
   */
  initialProjectPath?: string;
  /**
   * Tab ID for addressing the persistent process
   */
  tabId?: string;
  /**
   * Pre-filled session configuration when the chat tab was started from
   * the project view's inline form. When present, the New Session panel is
   * skipped and the session is started immediately on mount with these
   * values seeded into the session state.
   */
  initialSessionConfig?: {
    model: string;
    effort: EffortLevel;
    thinkingConfig?: ThinkingConfig;
    permissionMode: string;
    sessionStartMode?: SessionMode;
    accountResolution?: {
      account: {
        name: string;
        account_type: string;
        config_dir: string;
        session_defaults?: import('@/lib/api').SessionDefaults;
      };
      match_type: string;
      match_detail: string;
    };
  };
  /**
   * Optional className for styling
   */
  className?: string;
  /**
   * Callback when streaming state changes
   */
  onStreamingChange?: (isStreaming: boolean, sessionId: string | null) => void;
  /**
   * Callback when project path changes
   */
  onProjectPathChange?: (path: string) => void;
  /**
   * Whether this tab is currently the visible/active one. Gates the
   * auto-start effect so restored-but-inactive chat tabs don't fire
   * rebind/resume on app launch. The session activates the first time
   * the user views the tab. See `src/lib/sessionAutoStart.ts`.
   */
  isActive?: boolean;
}

/**
 * ClaudeCodeSession component for interactive Claude Code sessions.
 */
export const ClaudeCodeSession: React.FC<ClaudeCodeSessionProps> = ({
  session,
  initialProjectPath = "",
  tabId,
  initialSessionConfig,
  className,
  onStreamingChange,
  onProjectPathChange,
  isActive = true,
}) => {
  const [projectPath] = useState(initialProjectPath || session?.project_path || "");
  // Stream-derived per-tab state lives in `claudeSessionStore`. The hook
  // returns React-shaped setters so existing hook contracts (useSessionLifecycle,
  // useSendPrompt) keep working without changes.
  const sessionTabId = tabId || 'default';
  const {
    messages,
    setMessages,
    appendMessage,
    insertMessageBeforeFirstUser,
    isLoading,
    setIsLoading,
    extractedSessionInfo,
    setExtractedSessionInfo,
    claudeSessionId,
    setClaudeSessionId,
    sdkAccountInfo,
    setSdkAccountInfo,
    contextUsage,
    setContextUsage,
    supportedModels,
    setSupportedModels,
  } = useTabSession(sessionTabId);

  // `useTabSession` returns fresh setter/handler closures every render
  // (the wrappers in claudeSessionStore.ts re-create on each call).
  // Capturing them in a single stable ref here lets handleJsonlLine
  // and loadSessionHistory stay reference-stable across renders while
  // still reading the latest underlying functions at call time — the
  // streaming-session UX historically broke when callbacks recreated
  // (events dropped, queued prompts re-drained on stale closures).
  // See FOLLOW-UP-2026-05-14: ideally useTabSession would memoize its
  // own setters via useCallback so this ref isn't needed; tracked in
  // the architectural follow-up below the file.
  interface StreamCtx {
    appendMessage: typeof appendMessage;
    insertMessageBeforeFirstUser: typeof insertMessageBeforeFirstUser;
    handleSendPrompt:
      | ((prompt: string, model: string, images?: string[]) => Promise<unknown> | void)
      | null;
    setClaudeSessionId: typeof setClaudeSessionId;
    setContextUsage: typeof setContextUsage;
    setExtractedSessionInfo: typeof setExtractedSessionInfo;
    setIsLoading: typeof setIsLoading;
    setSdkAccountInfo: typeof setSdkAccountInfo;
    setSupportedModels: typeof setSupportedModels;
    setMessages: typeof setMessages;
    isMountedRef: { current: boolean } | null;
    queuedPromptsRef: { current: unknown[] } | null;
    setQueuedPrompts: ((next: unknown) => void) | null;
  }
  const streamCtxRef = useRef<StreamCtx>({
    appendMessage,
    insertMessageBeforeFirstUser,
    handleSendPrompt: null,
    setClaudeSessionId,
    setContextUsage,
    setExtractedSessionInfo,
    setIsLoading,
    setSdkAccountInfo,
    setSupportedModels,
    setMessages,
    isMountedRef: null,
    queuedPromptsRef: null,
    setQueuedPrompts: null,
  });
  // Update on every render so the ref always points at the latest set.
  // handleSendPrompt / isMountedRef / queuedPromptsRef / setQueuedPrompts
  // are populated below, after the hooks that own them have run.
  streamCtxRef.current.appendMessage = appendMessage;
  streamCtxRef.current.insertMessageBeforeFirstUser = insertMessageBeforeFirstUser;
  streamCtxRef.current.setClaudeSessionId = setClaudeSessionId;
  streamCtxRef.current.setContextUsage = setContextUsage;
  streamCtxRef.current.setExtractedSessionInfo = setExtractedSessionInfo;
  streamCtxRef.current.setIsLoading = setIsLoading;
  streamCtxRef.current.setSdkAccountInfo = setSdkAccountInfo;
  streamCtxRef.current.setSupportedModels = setSupportedModels;
  streamCtxRef.current.setMessages = setMessages;

  const [currentActivity, setCurrentActivity] = useState<string>("Honking");
  const [error, setError] = useState<string | null>(null);
  const [rawJsonlOutput, setRawJsonlOutput] = useState<string[]>([]);
  const [copyPopoverOpen, setCopyPopoverOpen] = useState(false);
  const [totalTokens, setTotalTokens] = useState(0);
  // Pre-fetched built-in slash commands from the SDK, loaded alongside models
  // during session init so the picker has them immediately.
  const [supportedCommands, setSupportedCommands] = useState<import('@/lib/api').SessionSlashCommand[]>([]);
  const [showMCPPanel, setShowMCPPanel] = useState(false);
  const [showPluginsPanel, setShowPluginsPanel] = useState(false);
  const [showPermissionsPanel, setShowPermissionsPanel] = useState(false);

  const [showSlashCommandsSettings, setShowSlashCommandsSettings] = useState(false);
  const [accountResolution, setAccountResolution] = useState<{
    account: { name: string; account_type: string; config_dir: string; session_defaults?: import('@/lib/api').SessionDefaults };
    match_type: string;
    match_detail: string;
  } | null>(initialSessionConfig?.accountResolution ?? null);
  const [showAccountPicker, setShowAccountPicker] = useState(false);

  /**
   * Latest rate-limit snapshots for the resolved account, keyed by
   * `rate_limit_type` (e.g. 'five_hour', 'seven_day'). Populated on mount
   * via `api.getRateLimits(accountName)` and refreshed live by subscribing
   * to the main process's `rate-limits:updated` event channel.
   */
  const [rateLimitSnapshots, setRateLimitSnapshots] = useState<
    Record<string, RateLimitSnapshot>
  >({});
  const [, setSessionCost] = useState(0);
  // Pre-session config: show setup panel for new sessions until user clicks
  // Start. When the tab was opened from the project view's inline form,
  // initialSessionConfig is set and we skip the panel entirely.
  // sessionStarted was previously a useState — deleted in favor of a
  // derivation over `sessionStatus` (from useSessionLifecycle) and the
  // mount-time session props. The actual derived constant is defined
  // below, after the hook call.
  const [selectedModel, setSelectedModel] = useState<string>(initialSessionConfig?.model ?? "opus[1m]");
  // Permission mode — the full SDK set ("default" | "acceptEdits" | "plan"
  // | "bypassPermissions"). Pre-session and in-session pickers both use
  // the same PERMISSION_MODES constant from FloatingPromptInput.
  // Default is acceptEdits per user preference — safer than bypass,
  // smoother than ask-every-time.
  const [permissionMode, setPermissionMode] = useState<string>(initialSessionConfig?.permissionMode ?? "acceptEdits");
  // Effort level — maps to the SDK's reasoning_effort parameter.
  // Default 'high' matches the SDK's own default (sdk.d.ts EffortLevel docs).
  // There is no 'auto' — the SDK's EffortLevel is strictly low/medium/high/xhigh/max.
  const [effort, setEffort] = useState<EffortLevel>(initialSessionConfig?.effort ?? 'high');
  // Thinking config — controls extended thinking behavior.
  const [thinkingConfig, setThinkingConfig] = useState<ThinkingConfig>(
    // initialSessionConfig may carry a legacy `'budget'` value if the
    // tab was launched from a pre-v0.4.21 saved-session form. Normalize
    // at the seed point so the rest of the component works in the
    // tightened two-state schema.
    normalizeThinkingConfig(initialSessionConfig?.thinkingConfig),
  );
  // Session start mode — chosen in the pre-session form. Defaults to 'rich'
  // (engine-driven chat). Set to 'tui' to start via local CLI in a PTY.
  const [sessionStartMode, setSessionStartMode] = useState<SessionMode>(
    initialSessionConfig?.sessionStartMode ?? 'rich',
  );
  // Unified per-tab git snapshot — project + all sibling worktrees streamed
  // from a single main-process watcher. Null until `startSessionGitWatch`
  // resolves; stays null when the project isn't a git repo.
  const [sessionGit, setSessionGit] = useState<import('@/lib/api').SessionGitSnapshot | null>(null);
  const [gitWatchId, setGitWatchId] = useState<string | null>(null);
  const [branchPins, setBranchPins] = useState<Record<string, string>>({});

  // Resizable header — null = natural sizing (default), number = user pick.
  const [headerHeight, setHeaderHeight] = useState<number | null>(() => {
    const raw = window.localStorage.getItem(HEADER_HEIGHT_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= MIN_HEADER_HEIGHT ? Math.min(MAX_HEADER_HEIGHT, n) : null;
  });
  const headerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (headerHeight == null) return;
    window.localStorage.setItem(HEADER_HEIGHT_KEY, String(headerHeight));
  }, [headerHeight]);
  const handleHeaderResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const headerEl = headerRef.current;
    if (!headerEl) return;
    const startY = e.clientY;
    const startHeight = headerHeight ?? headerEl.getBoundingClientRect().height;
    const handleEl = e.currentTarget;
    handleEl.setPointerCapture(e.pointerId);
    const prevBodyUserSelect = document.body.style.userSelect;
    const prevBodyCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(
        MIN_HEADER_HEIGHT,
        Math.min(MAX_HEADER_HEIGHT, startHeight + (ev.clientY - startY)),
      );
      setHeaderHeight(next);
    };
    const onUp = () => {
      handleEl.removeEventListener('pointermove', onMove);
      handleEl.removeEventListener('pointerup', onUp);
      handleEl.removeEventListener('pointercancel', onUp);
      document.body.style.userSelect = prevBodyUserSelect;
      document.body.style.cursor = prevBodyCursor;
    };
    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', onUp);
    handleEl.addEventListener('pointercancel', onUp);
  }, [headerHeight]);
  const handleHeaderResizeReset = useCallback(() => {
    setHeaderHeight(null);
    window.localStorage.removeItem(HEADER_HEIGHT_KEY);
  }, []);

  React.useEffect(() => {
    if (!projectPath) {
      setBranchPins({});
      return;
    }
    let cancelled = false;
    api.listBranchColors(projectPath).then((rows: BranchColor[]) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const r of rows) map[r.branch_name] = r.color;
      setBranchPins(map);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectPath]);

  // Resolve account explanation for SessionHeader. Skip when the chat tab was
  // opened with an explicit account override from the project landing page —
  // re-resolving via auto-rules would silently clobber the user's choice.
  const hasInitialAccountOverride = !!initialSessionConfig?.accountResolution;
  useEffect(() => {
    if (hasInitialAccountOverride) return;
    if (projectPath) {
      api.explainAccountResolution(projectPath).then((result) => {
        if (result) {
          setAccountResolution(result);
        }
      }).catch(console.error);
    }
  }, [projectPath, hasInitialAccountOverride]);

  // Apply per-account session defaults once when the account first resolves,
  // but only for new sessions (not when resuming or launched with explicit
  // config). The mount-time check (`!!session || !!initialSessionConfig`)
  // matches what the deleted `sessionStarted` state was seeded with —
  // `accountDefaultsApplied.current` then prevents subsequent re-runs.
  const accountDefaultsApplied = useRef(false);
  useEffect(() => {
    if (!accountResolution || accountDefaultsApplied.current) return;
    if (!!session || !!initialSessionConfig) return;
    const defaults = accountResolution.account.session_defaults;
    if (!defaults) return;
    accountDefaultsApplied.current = true;
    if (defaults.model) setSelectedModel(defaults.model);
    if (defaults.thinkingConfig) setThinkingConfig(normalizeThinkingConfig(defaults.thinkingConfig));
    if (defaults.permissionMode) setPermissionMode(defaults.permissionMode);
    if (defaults.effort) setEffort(defaults.effort);
  }, [accountResolution, session, initialSessionConfig]);

  // One per-tab git watch covers project status + worktree list + per-peer
  // status. The main process owns the fs.watch / poll machinery; we just
  // mirror the latest snapshot into render state.
  useEffect(() => {
    if (!projectPath) {
      setSessionGit(null);
      setGitWatchId(null);
      return;
    }
    let cancelled = false;
    let watchId: string | null = null;
    let unsub: (() => void) | null = null;

    logAndForget('claude-code-session:iife', (async () => {
      let result: { watchId: string; snapshot: import('@/lib/api').SessionGitSnapshot } | null = null;
      try {
        result = await api.startSessionGitWatch(projectPath);
      } catch {
        result = null;
      }
      if (cancelled) {
        if (result?.watchId) await api.stopSessionGitWatch(result.watchId);
        return;
      }
      if (!result) {
        setSessionGit(null);
        return;
      }
      watchId = result.watchId;
      setGitWatchId(result.watchId);
      setSessionGit(result.snapshot);
      unsub = api.onSessionGitChanged(result.watchId, setSessionGit);
    })());

    return () => {
      cancelled = true;
      unsub?.();
      if (watchId) void api.stopSessionGitWatch(watchId);
      setGitWatchId(null);
    };
  }, [projectPath]);

  // Project status + sibling worktrees derived from the unified snapshot.
  // `gitStatus` keeps the existing renderer ergonomics for the project badge;
  // `worktreeList` mirrors the snapshot's `worktrees[]` for the list below.
  const gitStatus = sessionGit?.project ?? null;
  // Wrap in useMemo so the `?? []` fallback doesn't create a new array
  // identity on each render — that ripples into the gitWatchErrors useMemo
  // below and triggers unnecessary recompute on every parent re-render.
  const worktreeList = useMemo(() => sessionGit?.worktrees ?? [], [sessionGit?.worktrees]);
  // Aggregate per-path errors for the single header status icon. The icon is
  // green when this list is empty and red when any path is errored; the
  // tooltip lists the offending labels so the user can see *which* row is
  // wedged without needing per-row icons.
  const gitWatchErrors = useMemo(() => {
    const out: { label: string; error: string }[] = [];
    if (gitStatus?.error) out.push({ label: gitStatus.branch ?? 'project', error: gitStatus.error });
    for (const wt of worktreeList) {
      if (wt.error) out.push({ label: wt.branch ?? wt.path, error: wt.error });
    }
    return out;
  }, [gitStatus, worktreeList]);

  const allBranchesForResolver: string[] = [
    ...(gitStatus?.branch ? [gitStatus.branch] : []),
    ...worktreeList.map((wt) => wt.branch ?? '(detached)'),
  ];
  const branchColorResolution = resolveBranchColors({
    pins: branchPins,
    mainFolderBranch: gitStatus?.branch ?? null,
    branches: allBranchesForResolver,
  });

  // New state for preview feature
  const [showPreview, setShowPreview] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [showPreviewPrompt, setShowPreviewPrompt] = useState(false);
  const [splitPosition, setSplitPosition] = useState(50);
  const [isPreviewMaximized, setIsPreviewMaximized] = useState(false);
  
  // Add collapsed state for queued prompts
  const [queuedPromptsCollapsed, setQueuedPromptsCollapsed] = useState(false);

  // Permission prompt state
  const {
    pendingPermission,
    setPendingPermission,
    waitingForPermission,
    handlePermissionAllow,
    handlePermissionDeny,
    handlePermissionAllowWithInput,
  } = usePermissions();

  // Elicitation state — MCP servers requesting user input
  const [elicitationRequest, setElicitationRequest] = useState<{
    serverName: string;
    message: string;
    mode?: 'form' | 'url';
    url?: string;
  } | null>(null);

  const parentRef = useRef<HTMLDivElement>(null);
  // Find-in-chat state. Cmd/Ctrl+F opens the floating FindBar; `useFindInChat`
  // walks `contentRef` (the messages list, not the scroll wrapper) and wraps
  // matches in <mark data-find>. transcriptVersion bumps on each new message
  // so highlights stay fresh while streaming. See FindBar.tsx +
  // useFindInChat.ts + docs/superpowers/specs/2026-05-11-find-in-chat-design.md.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const persistentSessionRef = useRef(false);
  // Live mirror of `isLoading` for call-time reads inside useSendPrompt's
  // queue gate. The drain path holds onto a captured handleSendPrompt
  // across renders; reading from the ref avoids the stale-closure bug
  // where drained prompts silently re-queue.
  const isLoadingRef = useRef(false);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);
  // Session lifecycle status comes from the useSessionLifecycle hook
  // (single source of truth), which subscribes to main-process
  // `session-status:<tabId>` events. We derive the legacy boolean flags
  // (isSessionStarting / isSessionActive) below — they keep call sites
  // readable but are no longer independent state.
  const [sessionMode, setSessionMode] = useState<SessionMode>('rich');
  // Open/close state for the SessionInspectorPanel — persisted across
  // app sessions so the user's preference sticks.
  const INSPECTOR_PREF_KEY = 'omnifex_session_inspector_open';
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(INSPECTOR_PREF_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(INSPECTOR_PREF_KEY, inspectorOpen ? '1' : '0'); } catch { /* private mode etc. */ }
  }, [inspectorOpen]);
  const tabIdRef = useRef(tabId || 'default');
  // Drop any per-tab inflight buffer when this tab unmounts so the
  // module-level Map doesn't leak across long-lived renderer sessions.
  // Pair with a store-slot clear so a stale Zustand slot can't survive
  // the unmount when a RAF was pending at teardown.
  useEffect(() => () => {
    const tabId = tabIdRef.current;
    clearInflightBuffer(tabId);
    useClaudeSessionStore.getState().clearInflightAssistant(tabId);
  }, []);
  const floatingPromptRef = useRef<FloatingPromptInputRef>(null);
  // Tracks whether the user just hit the cancel/interrupt button. When true,
  // the stream listener suppresses the next error-typed result message (which
  // the SDK emits after interrupt) so "Execution Failed" doesn't flash after
  // a deliberate cancel. Reset after the first result message is consumed.
  const userInterruptedRef = useRef(false);
  const isNearBottomRef = useRef(true);
  
  // Session metrics state for enhanced analytics
  const sessionMetrics = useRef({
    firstMessageTime: null as number | null,
    promptsSent: 0,
    toolsExecuted: 0,
    toolsFailed: 0,
    filesCreated: 0,
    filesModified: 0,
    filesDeleted: 0,
    codeBlocksGenerated: 0,
    errorsEncountered: 0,
    lastActivityTime: Date.now(),
    toolExecutionTimes: [] as number[],
    wasResumed: !!session,
    modelChanges: [] as { from: string; to: string; timestamp: number }[],
  });

  // Notify parent of the active projectPath. TabContent passes a fresh
  // inline closure for this prop on every render and its `updateTab`
  // implementation always allocates a new tabs array + new `updatedAt`
  // Date — so if we depended on the callback identity, the cycle would
  // be: parent render → new closure → effect fires → updateTab → parent
  // re-render → new closure → … (renderer pegged at >100% CPU at idle).
  // Capture the latest callback in a ref like onStreamingChange below
  // and key the effect on `projectPath` only, so it runs exactly once
  // per real change.
  const onProjectPathChangeRef = useRef(onProjectPathChange);
  onProjectPathChangeRef.current = onProjectPathChange;
  useEffect(() => {
    if (onProjectPathChangeRef.current && projectPath) {
      onProjectPathChangeRef.current(projectPath);
    }
  }, [projectPath]);

  // Get effective session info (from prop or extracted) - use useMemo to ensure it updates
  const effectiveSession = useMemo(() => {
    if (session) return session;
    if (extractedSessionInfo) {
      return {
        id: extractedSessionInfo.sessionId,
        project_id: extractedSessionInfo.projectId,
        project_path: projectPath,
        created_at: Date.now(),
      };
    }
    return null;
  }, [session, extractedSessionInfo, projectPath]);

  // Compact mode honors per-kind `hiddenInCompact` natively in the grouper —
  // hidden messages flow into HiddenEventsGroup expanders rather than being
  // pre-filtered, so opening any expander reveals everything that was hidden.
  const { config: renderConfig } = useMessageRenderingConfig();

  // Filter out messages that shouldn't be displayed (honors the user's
  // hard-filter toggles in Appearance settings).
  const displayableMessages = useMemo(
    () => filterDisplayableMessages(messages, renderConfig.hardFilters),
    [messages, renderConfig.hardFilters],
  );

  // Subagent (background task) state, derived from the raw stream.
  // Rendered above the prompt input so parallel Agent/Task dispatches are visible.
  const colorAllocatorRef = useRef(createSubagentColorAllocator());
  const [dismissedSubagents, setDismissedSubagents] = useState<Set<string>>(new Set());
  const subagents = useMemo(() => {
    const all = deriveSubagents(messages, colorAllocatorRef.current);
    return dismissedSubagents.size === 0
      ? all
      : all.filter((s) => !dismissedSubagents.has(s.toolUseId));
  }, [messages, dismissedSubagents]);
  // Typing bubble used to bridge on `hasRunningSubagent(subagents)` so a
  // stuck-running row would keep the spinner on after `isLoading` flipped
  // false. That coupled visual session activity to outstanding-subagent
  // state and faked a live turn whenever the subagent-tracking pipeline
  // missed a closure carrier. Decoupled now — the bubble follows
  // `isLoading` (driven by SDK turn state) and `tasksInFlight`. The
  // SubagentBar's per-row spinner remains the scoped indicator that a
  // particular dispatch is in flight. See design spec
  // docs/superpowers/specs/2026-05-11-subagent-tracking-refactor-design.md.
  // True iff the latest task list still has pending or in_progress items.
  // Folded into the spinner gate so the in-tab indicator matches the
  // popover's "busy" definition (turn || agents || tasks).
  const tasksInFlight = useMemo(() => {
    const tasks = getTaskList(messages);
    if (!tasks) return false;
    return summarizeTaskList(tasks).running;
  }, [messages]);
  // True when the streaming bubble is currently rendered. Used to
  // suppress the typing-dots spinner so the spinner and bubble
  // don't co-exist on screen.
  const hasInflightAssistant = useClaudeSessionStore(
    (s) => s.tabs[tabIdRef.current]?.inflightAssistant != null,
  );
  const outstandingWork = isLoading || tasksInFlight;
  const dismissSubagent = useCallback((toolUseId: string) => {
    colorAllocatorRef.current.release(toolUseId);
    setDismissedSubagents((prev) => {
      const next = new Set(prev);
      next.add(toolUseId);
      return next;
    });
  }, []);
  const dismissAllCompletedSubagents = useCallback(() => {
    for (const s of subagents) {
      if (s.status !== 'running') colorAllocatorRef.current.release(s.toolUseId);
    }
    setDismissedSubagents((prev) => {
      const next = new Set(prev);
      for (const s of subagents) {
        if (s.status !== 'running') next.add(s.toolUseId);
      }
      return next;
    });
  }, [subagents]);

  // Tab context for title / promptStatus mirror. The usePublishTabStatus
  // call lives further down — it depends on `isSessionActive` /
  // `isSessionStarting`, which are derived from `useSessionLifecycle`'s
  // `sessionStatus`.
  const { getTabById, updateTab } = useTabContext();
  const tabTitle = getTabById(tabIdRef.current)?.title ?? projectPath ?? tabIdRef.current;

  // promptStatus + tab mirror live further down — they depend on
  // `conversationStatus` from `useSessionLifecycle`. Subagent count and
  // task summary are pure derivations from messages/subagents state and
  // stay here so other code below can read them.
  const activeSubagentCount = subagents.reduce(
    (n, s) => (s.status === 'running' ? n + 1 : n),
    0,
  );
  const taskListSummary = useMemo(() => {
    const tasks = getTaskList(messages);
    return tasks
      ? summarizeTaskList(tasks)
      : { total: 0, done: 0, inProgress: 0, pending: 0, running: false };
  }, [messages]);

  const [viewMode, setViewMode] = useState<ViewMode>('compact');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Report streaming state changes — onStreamingChange is excluded from deps
  // because it's an event callback from the parent that may not be memoized.
  // Including it causes infinite re-render loops when the parent recreates
  // the callback on state change.
  const onStreamingChangeRef = useRef(onStreamingChange);
  onStreamingChangeRef.current = onStreamingChange;
  useEffect(() => {
    onStreamingChangeRef.current?.(isLoading, claudeSessionId);
  }, [isLoading, claudeSessionId]);

  // Auto-scroll to bottom when new messages arrive, but only if already near the bottom.
  // Always scroll when waiting for permission so the user sees the latest context.
  // Uses `behavior: 'auto'` (instant) during streaming — smooth scroll lags behind
  // rapid SDK message bursts and gets visually "stuck" mid-scroll.
  useEffect(() => {
    if (displayableMessages.length > 0 && (isNearBottomRef.current || waitingForPermission)) {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      });
    }
  }, [displayableMessages.length, waitingForPermission]);

  // Second-order auto-scroll: watch the message-list container for height changes
  // that don't coincide with a new message arriving. Without this, rendering a
  // large code block, a syntax-highlighted diff, or a lazy-loading image pushes
  // content below the viewport AFTER the length-change effect already fired, and
  // the chat looks "stuck" a few hundred pixels above the real bottom.
  const contentRef = useRef<HTMLDivElement>(null);

  // Cmd/Ctrl+F → open the find bar. Esc inside the bar closes it (handled by
  // FindBar itself). Listener is scoped to window because focus may be on
  // the FloatingPromptInput when the user wants to find — we want the
  // shortcut to work regardless. Bound only while the session is mounted.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); };
  }, []);

  const findResults = useFindInChat({
    containerRef: contentRef,
    query: findQuery,
    isOpen: findOpen,
    // Messages array grows on every stream tick; using `.length` as the
    // version keeps the highlight count fresh without needing a separate
    // counter. A wholesale-reload would also bump it.
    transcriptVersion: messages.length,
  });

  useEffect(() => {
    const contentEl = contentRef.current;
    const scrollEl = parentRef.current;
    if (!contentEl || !scrollEl || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (isNearBottomRef.current || waitingForPermission) {
        // Direct scrollTop assignment — cheaper than scrollIntoView and doesn't
        // fight the smooth-scroll animation the length-change effect may have
        // just kicked off in the same frame.
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
    });
    observer.observe(contentEl);
    return () => { observer.disconnect(); };
  }, [waitingForPermission]);

  // Calculate total tokens from messages — guard against undefined fields to avoid NaN
  useEffect(() => {
    const tokens = messages.reduce((total, msg) => {
      // Assistant rows carry usage on the wrapped BetaMessage; result rows
      // carry per-turn usage at the top level. Other variants have no tokens.
      if (msg.type === 'assistant' && msg.message?.usage) {
        return total + (msg.message.usage.input_tokens || 0) + (msg.message.usage.output_tokens || 0);
      }
      if (msg.type === 'result' && msg.usage) {
        return total + (msg.usage.input_tokens || 0) + (msg.usage.output_tokens || 0);
      }
      return total;
    }, 0);
    setTotalTokens(tokens);
  }, [messages]);

  // Load session history when resuming an existing session. Uses
  // streamCtxRef for the useTabSession setters that recreate every
  // render — without that indirection, this callback would re-create on
  // every render and re-trigger the effect below, re-fetching history
  // every frame.
  const loadSessionHistory = useCallback(async () => {
    if (!session) return;

    try {
      streamCtxRef.current.setIsLoading(true);
      setError(null);

      const history = await api.loadSessionHistory(session.id, session.project_id, session.project_path);

      // Save session data for restoration
      if (history && history.length > 0) {
        SessionPersistenceService.saveSession(
          session.id,
          session.project_id,
          session.project_path,
          history.length
        );
      }

      // Route through the JSONL classifier → synthesizer → adapter pipeline.
      // The classifier normalizes timestamp→receivedAt and discriminates
      // every line into a typed JsonlNode; synthesizeBatch injects the
      // synthesized-init and synthesized-result nodes that produce the
      // "Execution Complete" card; the adapter translates back to
      // ClaudeStreamMessage. normalizeMessageContent handles string→array
      // content for downstream consumers expecting array form.
      const nodes = history
        .map((entry) => classifyJsonlLine(entry))
        .filter((n): n is NonNullable<typeof n> => n !== null);

      const synthesized = synthesizeBatch(nodes);

      const messagesWithResults: ClaudeStreamMessage[] = synthesized
        .map((n) => jsonlNodeToStreamMessage(n))
        .filter((m): m is NonNullable<typeof m> => m !== null)
        .map((m) => normalizeMessageContent(m));

      streamCtxRef.current.setMessages(messagesWithResults);
      setRawJsonlOutput(history.map(h => JSON.stringify(h)));

      // Scroll to bottom after loading history
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      }, 100);
    } catch (err) {
      console.error("Failed to load session history:", err);
      setError("Failed to load session history");
    } finally {
      streamCtxRef.current.setIsLoading(false);
    }
  }, [session]);

  // Resume effect: when a session prop is provided, seed claudeSessionId
  // and load history. setClaudeSessionId routed through streamCtxRef
  // because it's a useTabSession setter that recreates per render.
  useEffect(() => {
    if (session) {
      streamCtxRef.current.setClaudeSessionId(session.id);
      logAndForget('claude-code-session:load-session-history', loadSessionHistory());
    }
  }, [session, loadSessionHistory]);

  // One synthesizer instance per session lifetime. State persists across
  // messages so init-once and turn-tracking work correctly.
  const synthesizerRef = useRef(createSynthesizer());

  const handleJsonlLine = useCallback((payload: string | object) => {
    try {
      if (!streamCtxRef.current.isMountedRef?.current) return;
      let raw: unknown;
      let rawString: string;
      if (typeof payload === 'string') {
        rawString = payload;
        raw = JSON.parse(payload);
      } else {
        raw = payload;
        rawString = JSON.stringify(payload);
      }

      // permission_request — OmniFex-synthetic envelope from the main-process
      // permissions service. Not a JSONL record; classifier doesn't know it.
      if (raw && typeof raw === 'object' && (raw as any).type === 'permission_request') {
        const msg = raw as any;
        setPendingPermission({
          requestId: msg.request_id,
          toolName: msg.tool_name,
          toolInput: msg.tool_input ?? {},
          title: msg.title,
          displayName: msg.display_name,
          description: msg.description,
          decisionReason: msg.decision_reason,
          blockedPath: msg.blocked_path,
          suggestions: msg.permission_suggestions ?? [],
        });
        return;
      }

      // stream_event — SDK iterator overlay channel (token partials).
      // Not in JSONL; route partials to the inflight coalescer for the
      // typewriter effect. Subagent partials and non-text deltas drop.
      if (raw && typeof raw === 'object' && (raw as any).type === 'stream_event') {
        const m = raw as any;
        if (m.parent_tool_use_id != null) return;
        const event = m.event;
        if (
          event?.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          typeof event.delta.text === 'string'
        ) {
          appendInflightDelta(tabIdRef.current, m.uuid, event.delta.text, m.parent_tool_use_id);
        }
        return;
      }

      // Classify + synthesize. Synthesizer injects synth-init on first
      // sessioned node and synth-result after assistant with terminal
      // stop_reason. Adapter converts both to ClaudeStreamMessage shape so
      // the reducer can process them identically to SDK iterator events.
      const node = classifyJsonlLine(raw);
      if (!node) return;
      const produced = synthesizerRef.current.push(node);
      const streamMessages = produced
        .map((n) => jsonlNodeToStreamMessage(n))
        .filter((m): m is NonNullable<ReturnType<typeof jsonlNodeToStreamMessage>> => m !== null)
        .map((m) => normalizeMessageContent(m));
      if (streamMessages.length === 0) return;

      // Store raw line (only the original input, not the synthesized rows).
      setRawJsonlOutput((prev) => [...prev, rawString]);

      const ctx = streamCtxRef.current;

      // Each stream message goes through the reducer for its side effects:
      // activity labels, metrics, cost, session-id extraction, permission
      // dispatch, userInterrupted suppression, post-event refresh effects,
      // and the append/skip/insert decision. The reducer is pure — same
      // contract as the old SDK-iterator path.
      for (const message of streamMessages) {
        const liveSlice = useClaudeSessionStore.getState().selectTab(sessionTabId);
        const hasExistingInit = liveSlice.messages.some(
          (m) => m.type === 'system' && m.subtype === 'init',
        );
        const reduced = reduceSessionStreamMessage(message, {
          projectPath,
          hasExistingInit,
          hasExtractedSession: !!liveSlice.extractedSessionInfo,
          userInterrupted: userInterruptedRef.current,
          messagesLength: liveSlice.messages.length,
        });

        if (reduced.activityUpdate) {
          setCurrentActivity(
            reduced.activityUpdate.kind === 'literal'
              ? reduced.activityUpdate.label
              : pickGerund(),
          );
        }

        const m = reduced.metrics;
        if (
          m.toolsExecuted ||
          m.toolsFailed ||
          m.filesCreated ||
          m.filesModified ||
          m.filesDeleted ||
          m.codeBlocksGenerated ||
          m.errorsEncountered ||
          m.bumpLastActivity
        ) {
          const live = sessionMetrics.current;
          live.toolsExecuted += m.toolsExecuted;
          live.toolsFailed += m.toolsFailed;
          live.filesCreated += m.filesCreated;
          live.filesModified += m.filesModified;
          live.filesDeleted += m.filesDeleted;
          live.codeBlocksGenerated += m.codeBlocksGenerated;
          live.errorsEncountered += m.errorsEncountered;
          if (m.bumpLastActivity) live.lastActivityTime = Date.now();
        }

        if (reduced.costDelta > 0) {
          setSessionCost((prev) => prev + reduced.costDelta);
        }

        if (reduced.sessionIdUpdate) {
          ctx.setClaudeSessionId(reduced.sessionIdUpdate);
        }
        if (reduced.extractedSessionInfo) {
          ctx.setExtractedSessionInfo(reduced.extractedSessionInfo);
        }
        if (reduced.pendingPermission) {
          setPendingPermission(reduced.pendingPermission);
        }
        if (reduced.clearUserInterrupted) {
          userInterruptedRef.current = false;
        }
        if (reduced.clearLoading) {
          ctx.setIsLoading(false);
        }

        const handleSendPromptForEffect = ctx.handleSendPrompt;
        for (const effect of reduced.effects) {
          runStreamEffect(effect, {
            tabId: tabIdRef.current,
            projectPath,
            api: {
              sessionAccountInfo: api.sessionAccountInfo,
              sessionContextUsage: api.sessionContextUsage,
              sessionSupportedModels: api.sessionSupportedModels,
              sessionSupportedCommands: api.sessionSupportedCommands,
            },
            persistSession: ({ sessionId, projectId, projectPath: pp, messageCount }) =>
              { SessionPersistenceService.saveSession(sessionId, projectId, pp, messageCount); },
            setSdkAccountInfo: (info) => { ctx.setSdkAccountInfo(info as any); },
            setContextUsage: (usage) => { ctx.setContextUsage(usage as any); },
            setSupportedModels: (models) => { ctx.setSupportedModels(models as any); },
            setSupportedCommands: (commands) => { setSupportedCommands(commands as any); },
            queuedPromptsRef: ctx.queuedPromptsRef as any,
            setQueuedPrompts: ctx.setQueuedPrompts as any,
            handleSendPrompt: fireAndLog(
              'claude-code-session:send-prompt-effect',
              handleSendPromptForEffect ?? undefined,
            ),
            onError: (kind, err) =>
              { console.error(`[sessions] effect ${kind} failed:`, err); },
          });
        }

        // Reconcile inflight assistant: clear streaming bubble when canonical
        // message arrives or an error notification lands.
        const store = useClaudeSessionStore.getState();
        if (reduced.append === 'append' && message.type === 'assistant') {
          store.clearInflightAssistant(tabIdRef.current);
          clearInflightBuffer(tabIdRef.current);
        }
        if (
          message.type === 'system' &&
          message.subtype === 'notification' &&
          /error/i.test(String((message as any).notification_type ?? ''))
        ) {
          store.clearInflightAssistant(tabIdRef.current);
          clearInflightBuffer(tabIdRef.current);
        }

        if (reduced.append === 'skip') continue;
        if (reduced.append === 'insertBeforeFirstUser') {
          ctx.insertMessageBeforeFirstUser(message);
          continue;
        }
        ctx.appendMessage(message);
      }
    } catch (err) {
      // Write directly to app_logs (not via console.error → LogService).
      // LogService batches console.error every 2s; when a stream message
      // throws here, the user needs the toast NOW so they can correlate
      // it with what they just saw, and we don't want a swallowed payload
      // to vanish if the renderer reloads before the batch flushes. The
      // main-process onError observer (main.ts → log_error_toast_enabled)
      // turns this into a user-visible toast with a "View in Log" action.
      const errMsg =
        err instanceof Error
          ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`
          : String(err);
      const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
      api.logWriteBatch([{
        timestamp: new Date().toISOString(),
        level: 'error',
        source: 'frontend',
        category: `session:${tabIdRef.current}:handle-jsonl-line`,
        message: `handleJsonlLine threw: ${errMsg}`,
        metadata: JSON.stringify({ payloadPreview: payloadStr.slice(0, 500) }),
      }]).catch(() => {
        // logWriteBatch failure means IPC is gone — the renderer is
        // already in a worse state than a missing log entry. Nothing
        // useful to do; do NOT fall back to console.error (the user
        // asked specifically to keep this off console).
      });
    }
  }, [projectPath, sessionTabId, setPendingPermission]);

  // Session lifecycle: persistent session management, event listeners, cleanup
  const {
    unlistenRefs,
    isMountedRef,
    startPersistentSession,
    rebindPersistentSession,
    sessionStatus,
    conversationStatus,
    resetStatus,
  } = useSessionLifecycle({
    tabId: tabIdRef.current,
    projectPath,
    selectedModel,
    permissionMode,
    effort,
    thinkingConfig,
    sessionStartMode,
    accountResolution,
    persistentSessionRef,
    // Seed sessionStatus to 'starting' (instead of 'stopped') when this
    // tab is mounting with a session to resume or a preconfigured fresh
    // start — the auto-start effect below will kick in shortly, and this
    // skips the one-frame flash of the empty-state form.
    hasPendingStart: !!session || !!initialSessionConfig,
    handleJsonlLine,
    setIsLoading,
    setMessages,
    // session-init:<tabId> seeds claudeSessionId + extractedSessionInfo the
    // moment the CLI subprocess spawns, instead of waiting for the
    // mid-first-turn `system:init` stream message.
    onSessionInit: useCallback((sessionId: string) => {
      streamCtxRef.current.setClaudeSessionId(sessionId);
      const projectId = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
      streamCtxRef.current.setExtractedSessionInfo({ sessionId, projectId });
      SessionPersistenceService.saveSession(sessionId, projectId, projectPath, 0);
    }, [projectPath]),
  });
  // Derived predicates over the two canonical axes. See
  // docs/session-lifecycle.md for the model:
  //  - isSessionStarting → connection dialing
  //  - isSessionActive   → connection up ('started'); covers all
  //                        conversationStatus values
  const isSessionStarting = sessionStatus === 'starting';
  const isSessionActive = sessionStatus === 'started';
  // "Has the user committed to a session in this tab?" Gates the
  // NewSessionForm empty-state vs. the chat view. The hook seeds
  // sessionStatus to 'starting' at mount when there's a session to
  // resume or a preconfigured fresh start (see hasPendingStart above),
  // so this single check covers all cases without a one-frame flash.
  const sessionStarted = sessionStatus !== 'stopped';

  // Canonical in-flight predicate. See docs/session-lifecycle.md.
  // 'working' iff:
  //  - conversationStatus is non-null and non-idle (mid-turn or paused on
  //    a permission prompt), OR
  //  - any subagent is running, OR
  //  - any task is in_progress.
  // isLoading is the renderer's local mirror of "user submitted, waiting on
  // first SDK echo." Including it as well prevents a frame of "ready" in
  // the brief window between submit and the SDK acknowledging it.
  const isConversationInFlight =
    conversationStatus !== null && conversationStatus !== 'idle';
  const promptStatus: 'working' | 'ready' =
    isLoading || isConversationInFlight || activeSubagentCount > 0 || taskListSummary.running
      ? 'working'
      : 'ready';
  const lastPromptStatusRef = useRef<'working' | 'ready' | null>(null);
  useEffect(() => {
    if (lastPromptStatusRef.current === promptStatus) return;
    lastPromptStatusRef.current = promptStatus;
    updateTab(tabIdRef.current, { promptStatus });
  }, [promptStatus, updateTab]);

  // Publish this tab's busy/idle summary up to main on every change. The
  // status popover and the install-gate both read from the aggregated list.
  usePublishTabStatus({
    tabId: tabIdRef.current,
    title: tabTitle,
    projectPath: projectPath ?? null,
    sessionStarted: isSessionActive,
    isStarting: isSessionStarting,
    isLoading,
    hasError: error !== null,
    messages,
    subagents,
    contextUsage,
    branch: gitStatus?.branch ?? null,
    filesChanged: gitStatus?.changed ?? 0,
    filesUntracked: gitStatus?.untracked ?? 0,
    pendingPermission,
  });

  // Prompt sending and queuing
  const { handleSendPrompt: sendPromptRaw, queuedPrompts, setQueuedPrompts, queuedPromptsRef } = useSendPrompt({
    projectPath,
    tabId: tabIdRef.current,
    isLoadingRef,
    selectedModel,
    persistentSessionRef,
    unlistenRefs,
    effectiveSession,
    claudeSessionId,
    sessionMetrics,
    startPersistentSession,
    pickGerund,
    setIsLoading,
    setError,
    setCurrentActivity,
    setSelectedModel,
    setMessages,
  });

  // Wrap sendPrompt so that sending a new prompt always re-engages bottom-stickiness.
  // If the user was scrolled up reading history and sends a new message, they expect
  // the view to follow their new activity rather than leave them stranded.
  const handleSendPrompt = useCallback(
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- preserved as-is.
    (prompt: string, model: string, images?: string[]) => {
      isNearBottomRef.current = true;
      return sendPromptRaw(prompt, model, images);
    },
    [sendPromptRaw],
  );

  // Stable resend callback. Without memoization, every render of this
  // component handed every `StreamMessage` a fresh `onResend` function ref,
  // which defeated `React.memo` and forced the inner `ReactMarkdown` →
  // `SyntaxHighlighter` tree to rebuild — wiping any active text selection
  // inside the inner code card.
  const handleResend = useCallback(
    (text: string, images: string[] | undefined) =>
      handleSendPrompt(text, selectedModel, images),
    [handleSendPrompt, selectedModel],
  );
  const onResendStable = useMemo(
    () => fireAndLog('claude-code-session:resend', handleResend),
    [handleResend],
  );

  // Populate the late-bound entries on streamCtxRef now that the hooks
  // that own them have run. handleJsonlLine reads these through the ref
  // so it never needs to list them as deps.
  streamCtxRef.current.handleSendPrompt = handleSendPrompt;
  streamCtxRef.current.isMountedRef = isMountedRef;
  streamCtxRef.current.queuedPromptsRef = queuedPromptsRef;
  streamCtxRef.current.setQueuedPrompts = setQueuedPrompts as unknown as (next: unknown) => void;

  // Auto-resume / auto-start. Three distinct cases:
  //   1. Renderer reload (Cmd+R) while a session is running in the main
  //      process — rebind to it so the in-flight SDK query keeps streaming
  //      and prompts still reach the open subprocess. Tearing down a
  //      healthy session here used to leave the new query unable to
  //      receive input (spinner stuck, no output).
  //   2. Cold tab restore from a previous app run — no live session in
  //      main, so spawn a fresh resume from the persisted session id.
  //   3. New session started from the project view's inline form — no
  //      session id to resume from, just spawn a fresh one with the
  //      pre-filled config the user already chose. Skips the second click.
  useEffect(() => {
    const action = decideAutoStart({
      isActive,
      alreadyStarted: persistentSessionRef.current,
      hasSession: !!session,
      hasInitialSessionConfig: !!initialSessionConfig,
    });
    if (action === 'skip') return;
    if (action === 'rebind-or-resume' && session) {
      (async () => {
        const rebound = await rebindPersistentSession();
        if (!rebound) {
          await startPersistentSession(session.id);
        }
      })().catch((err: unknown) => { console.error("[auto-start] resume/rebind failed:", err); });
    } else if (action === 'fresh-start') {
      startPersistentSession().catch((err: unknown) =>
        { console.error("[auto-start] fresh start failed:", err); },
      );
    }
  }, [isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for elicitation requests from MCP servers
  useEffect(() => {
    const unlisten = window.electronAPI.onEvent(
      `elicitation-request:${tabIdRef.current}`,
      (payload: any) => {
        setElicitationRequest(payload);
      },
    );
    return () => { unlisten(); };
  }, []);

  // Rate-limit snapshots for the active account: fetch initial state on
  // resolution, then live-update from the main process's
  // `rate-limits:updated` event whenever an SDK rate-limit event lands.
  const activeAccountName = accountResolution?.account.name ?? null;
  useEffect(() => {
    if (!activeAccountName) {
      setRateLimitSnapshots({});
      return;
    }
    let cancelled = false;
    api.getRateLimits(activeAccountName)
      .then((snaps) => {
        if (cancelled) return;
        const byType: Record<string, RateLimitSnapshot> = {};
        for (const s of snaps) byType[s.rate_limit_type] = s;
        setRateLimitSnapshots(byType);
      })
      .catch((err: unknown) => { console.error('[rate-limits] initial fetch failed:', err); });

    const unlisten = window.electronAPI.onEvent(
      'rate-limits:updated',
      (...args: unknown[]) => {
        const payload = args[0] as
          | { account_name?: string; snapshot?: RateLimitSnapshot }
          | undefined;
        if (!payload?.snapshot) return;
        if (payload.account_name !== activeAccountName) return;
        const next = payload.snapshot;
        setRateLimitSnapshots((prev) => ({
          ...prev,
          [next.rate_limit_type]: next,
        }));
      },
    );
    return () => {
      cancelled = true;
      unlisten();
    };
  }, [activeAccountName]);

  // Ref-indirected reload so the session-mode effect can stay [] while
  // reading the latest claudeSessionId / projectId / projectPath.
  const reloadHistoryRef = useRef<() => void>(() => {});
  useEffect(() => {
    reloadHistoryRef.current = () => {
      if (!claudeSessionId || !extractedSessionInfo?.projectId) return;
      api.loadSessionHistory(
        claudeSessionId,
        extractedSessionInfo.projectId,
        projectPath,
      )
        .then((history) => {
          if (!history || history.length === 0) return;
          // Mirror loadSessionHistory(): route through classify→synthesize→adapt.
          const nodes = history
            .map((entry: unknown) => classifyJsonlLine(entry))
            .filter((n): n is NonNullable<typeof n> => n !== null);
          const synthesized = synthesizeBatch(nodes);
          const loaded: ClaudeStreamMessage[] = synthesized
            .map((n) => jsonlNodeToStreamMessage(n))
            .filter((m): m is NonNullable<typeof m> => m !== null)
            .map((m) => normalizeMessageContent(m));
          setMessages(loaded);
        })
        .catch((err: unknown) => {
          console.error('Failed to reload history on TUI->Chat:', err);
        });
    };
  }, [claudeSessionId, extractedSessionInfo, projectPath, setMessages]);

  // Listen for session mode changes from main process
  useEffect(() => {
    const unlisten = window.electronAPI.onEvent(
      `session-mode:${tabIdRef.current}`,
      (...args: unknown[]) => {
        const payload = args[0] as { mode?: SessionMode } | undefined;
        if (payload?.mode === 'rich' || payload?.mode === 'tui') {
          setSessionMode(payload.mode);
          // A mode switch means the main process has a live session handle
          // on the other side of the toggle. Keep the header badge active
          // rather than dropping back to 'Starting…' while the restarted
          // SDK query waits for its first message.
          resetStatus({ sessionStatus: 'started', conversationStatus: 'idle' });
          // On return to SDK mode, reload history from the JSONL file.
          // TUI-mode turns wrote to the session file but never flowed
          // through our claude-output events, so they're missing from
          // messages[]. The ref indirection keeps this stable across
          // the effect's [] deps while reading live state.
          if (payload.mode === 'rich') reloadHistoryRef.current();
        }
      },
    );
    return () => { unlisten(); };
  }, []);

  // session-status events are now consumed by useSessionLifecycle, which
  // exposes the resulting `sessionStatus` enum. Derived `isSessionStarting`
  // / `isSessionActive` predicates above.

  // Keep queuedPromptsRef in sync with state
  useEffect(() => {
    queuedPromptsRef.current = queuedPrompts;
  }, [queuedPrompts, queuedPromptsRef]);

  const handleCopyAsJsonl = async () => {
    await exportAsJsonl(rawJsonlOutput);
    setCopyPopoverOpen(false);
  };

  const handleCopyAsMarkdown = async () => {
    await exportAsMarkdown(messages, projectPath);
    setCopyPopoverOpen(false);
  };

  // Wave 2.3 — "cancel" is now a soft interrupt. The old behavior called
  // api.stopSession() which fully tore down the SDK session, killing the
  // Claude subprocess, losing conversation history, and forcing a restart
  // on the next prompt. Now we call api.sessionInterrupt() which halts the
  // current assistant turn but keeps the session alive so the user can
  // continue typing. If interrupt fails (old SDK, bad state, subprocess
  // crash), we fall back to the hard stop path to guarantee the UI unsticks.
  const handleCancelExecution = async () => {
    if (!isLoading) return;

    const tid = tabIdRef.current;

    try {
      // Flag so the stream listener suppresses the next SDK error-result
      // message (the SDK emits is_error after interrupt and we don't want
      // an "Execution Failed" card for a deliberate user cancel).
      userInterruptedRef.current = true;

      await api.sessionInterrupt(tid);

      // Session stays alive — don't clean up listeners, don't unset
      // persistentSessionRef. The SDK will emit a result message with
      // stop_reason "interrupted" which the normal message loop handles.
      setIsLoading(false);
      setError(null);
      setQueuedPrompts([]);

      const interruptMessage: ClaudeStreamMessage = {
        type: "system",
        subtype: "notification",
        body: "Response interrupted — session still active",
        notification_type: "stop",
        timestamp: new Date().toISOString(),
      } as any;
      setMessages((prev) => [...prev, interruptMessage]);
    } catch (err) {
      // Interrupt failed. Fall back to the hard stopSession path so the UI
      // at least unsticks, even if the session has to be restarted on the
      // next prompt.
      console.error("sessionInterrupt failed, falling back to stopSession:", err);

      try {
        await api.stopSession(tid);
      } catch (stopErr) {
        console.error("stopSession also failed:", stopErr);
      }

      unlistenRefs.current.forEach((unlisten) => { unlisten(); });
      unlistenRefs.current = [];

      setIsLoading(false);
      persistentSessionRef.current = false;
      resetStatus({ sessionStatus: 'stopped', conversationStatus: null });
      setError(null);
      setQueuedPrompts([]);

      const errorMessage: ClaudeStreamMessage = {
        type: "system",
        subtype: "notification",
        body: "Session cancelled by user",
        notification_type: "stop",
        timestamp: new Date().toISOString(),
      } as any;
      setMessages((prev) => [...prev, errorMessage]);
    }
  };

  // Clear the conversation: stop the current SDK session, reset all
  // renderer-side state, then start a fresh session in the same tab. The
  // old JSONL transcript stays on disk; this just begins a new session
  // ID with no resume, mirroring what `/clear` does in the Claude Code
  // CLI. Only safe to call when nothing is in flight.
  /**
   * Force-reconnect handler exposed via the inline icon in the status badge.
   * Unlike `handleClear`, this preserves the message history — it just tears
   * down stale renderer flags / listeners and either rebinds to a still-alive
   * main-process session or spawns a fresh one (resuming from
   * claudeSessionId when available).
   */
  const handleReconnect = async () => {
    const tid = tabIdRef.current;

    // Reset our local connected-flag so rebind actually attempts the IPC.
    // (rebindPersistentSession short-circuits to true when the ref is true.)
    persistentSessionRef.current = false;

    // Try the cheap rebind first — if main still has a healthy handle for
    // this tab (e.g. after a renderer hot-reload), we reattach without
    // spawning a new SDK process. Previously this code stopped the session
    // first, which guaranteed rebind would fail and the cold-resume path
    // always ran — defeating the comment's "cheap rebind first" intent.
    const rebound = await rebindPersistentSession().catch(() => false);
    if (rebound) return;

    // Rebind failed — main has no live handle (or a zombie one). Tear
    // down anything stale, reset renderer state, then cold-start, resuming
    // from claudeSessionId when available so the message history continues.
    try { await api.stopSession(tid); } catch { /* best effort */ }

    unlistenRefs.current.forEach((u) => { u(); });
    unlistenRefs.current = [];

    resetStatus({ sessionStatus: 'stopped', conversationStatus: null });
    setIsLoading(false);
    setError(null);

    try {
      await startPersistentSession(claudeSessionId ?? undefined);
    } catch (err) {
      console.error('reconnect: startPersistentSession failed:', err);
      setError('Failed to reconnect: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleClear = async () => {
    if (!isSessionActive || isLoading || waitingForPermission) return;
    const tid = tabIdRef.current;

    try {
      await api.stopSession(tid);
    } catch (err) {
      console.error('clear: stopSession failed:', err);
    }

    // Tear down the stream listeners attached to the dead session.
    unlistenRefs.current.forEach((unlisten) => { unlisten(); });
    unlistenRefs.current = [];

    // Session-state flags
    persistentSessionRef.current = false;
    resetStatus({ sessionStatus: 'stopped', conversationStatus: null });
    setIsLoading(false);
    setError(null);
    setQueuedPrompts([]);

    // Conversation state
    setMessages([]);
    setRawJsonlOutput([]);
    setTotalTokens(0);
    setSessionCost(0);
    setClaudeSessionId(null);
    setContextUsage(null);
    setSdkAccountInfo(null);
    setExtractedSessionInfo(null);

    // Spin up a fresh session (no resumeId) so the user can keep typing.
    try {
      await startPersistentSession();
    } catch (err) {
      console.error('clear: startPersistentSession failed:', err);
    }
  };

  // Handle URL detection from terminal output
  const handleLinkDetected = (url: string) => {
    if (!showPreview && !showPreviewPrompt) {
      setPreviewUrl(url);
      setShowPreviewPrompt(true);
    }
  };

  const handleClosePreview = () => {
    setShowPreview(false);
    setIsPreviewMaximized(false);
    // Keep the previewUrl so it can be restored when reopening
  };

  const handlePreviewUrlChange = (url: string) => {
    setPreviewUrl(url);
  };

  const handleTogglePreviewMaximize = () => {
    setIsPreviewMaximized(!isPreviewMaximized);
    // Reset split position when toggling maximize
    if (isPreviewMaximized) {
      setSplitPosition(50);
    }
  };

  const scrollToTop = useCallback(() => {
    parentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Two-threshold hysteresis to prevent false "user scrolled up" detection.
    // Wider-than-you'd-expect thresholds so content-height jitter (code blocks
    // finishing layout, images loading) doesn't disengage stickiness, and the
    // user has real room to scroll back without the view yanking to the bottom:
    // - Within 400px: near bottom, keep auto-scrolling
    // - Beyond 800px: user is reading history, stop auto-scrolling
    // - 400–800px: dead zone (no state change)
    if (distanceFromBottom < 400) {
      isNearBottomRef.current = true;
    } else if (distanceFromBottom > 800) {
      isNearBottomRef.current = false;
    }
  }, []);

  const messagesList = (
    <div className="flex-1 min-h-0 px-10 py-2 bg-muted/30 relative">
    {findOpen && (
      <FindBar
        query={findQuery}
        onQueryChange={setFindQuery}
        count={findResults.count}
        activeIndex={findResults.activeIndex}
        onNext={findResults.next}
        onPrev={findResults.prev}
        onClose={() => { setFindOpen(false); setFindQuery(''); }}
      />
    )}
    <div className="absolute right-1 bottom-6 z-10 flex flex-col gap-1">
      <TooltipSimple content="Scroll to top" side="left">
        <Button
          variant="ghost"
          size="icon"
          onClick={scrollToTop}
          className="h-8 w-8 hover:bg-accent/50 transition-colors bg-background/80 backdrop-blur-sm border border-border/50"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
      </TooltipSimple>
      <TooltipSimple content="Scroll to bottom" side="left">
        <Button
          variant="ghost"
          size="icon"
          onClick={scrollToBottom}
          className="h-8 w-8 hover:bg-accent/50 transition-colors bg-background/80 backdrop-blur-sm border border-border/50"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </TooltipSimple>
    </div>
    <div
      ref={parentRef}
      className="h-full overflow-y-auto relative border border-border/50 rounded-lg bg-background"
      onScroll={handleScroll}
      style={{
        contain: 'paint',
      }}
    >
      <div ref={contentRef} className="w-full px-4 pt-8 pb-4 space-y-4">
          {viewMode === 'verbose'
            ? displayableMessages.map((message, idx) => (
                <div key={idx}>
                  <StreamMessage
                    message={message}
                    streamMessages={messages}
                    onLinkDetected={handleLinkDetected}
                    accountType={accountResolution?.account.account_type}
                    onResend={onResendStable}
                  />
                </div>
              ))
            : (() => {
                const items = buildCompactItems(displayableMessages, renderConfig);
                return items.map((item) =>
                  item.kind === 'single' ? (
                    <div key={item.key}>
                      <StreamMessage
                        message={item.message}
                        streamMessages={messages}
                        onLinkDetected={handleLinkDetected}
                        accountType={accountResolution?.account.account_type}
                        compact
                        onResend={onResendStable}
                      />
                    </div>
                  ) : (
                    <HiddenEventsGroup
                      key={item.key}
                      messages={item.messages}
                      streamMessages={messages}
                      accountType={accountResolution?.account.account_type}
                      onLinkDetected={handleLinkDetected}
                      onResend={onResendStable}
                    />
                  ),
                );
              })()}

          {/* Streaming bubble — renders null when no in-flight slot is set. */}
          <InflightAssistantBubble tabId={tabIdRef.current} />

          {/* Loading indicator under the latest message — iMessage-style typing bubble.
              Rendered inside contentRef (and before messagesEndRef) so the ResizeObserver
              on contentRef catches its appearance/height changes, and scrollIntoView on
              messagesEndRef scrolls past it instead of leaving it below the viewport.
              Also kept visible during awaiting_background so the visual "in-flight"
              cue bridges the parent's turn-end result to the eventual completion. */}
          {outstandingWork && !hasInflightAssistant && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
              className="flex justify-start mb-20"
            >
              <div className="max-w-[95%] space-y-2">
                <div className="flex items-center gap-3">
                  <div className="inline-flex items-center gap-1 rounded-2xl rounded-bl-sm bg-primary/10 border border-primary/20 px-4 py-3">
                    <span className="typing-dot" />
                    <span className="typing-dot" style={{ animationDelay: '0.15s' }} />
                    <span className="typing-dot" style={{ animationDelay: '0.3s' }} />
                  </div>
                  <div className="flex items-baseline gap-2 text-xs font-mono">
                    <span className="text-primary">✶</span>
                    <span className="text-muted-foreground">{currentActivity}...</span>
                    <span className="text-muted-foreground/60">
                      (↓ {totalTokens.toLocaleString()} tokens)
                    </span>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {/* Error indicator */}
          {error && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
              className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive mb-20 w-full max-w-6xl mx-auto"
            >
              {error}
            </motion.div>
          )}

          <div ref={messagesEndRef} />
      </div>
    </div>
    </div>
  );


  // If preview is maximized, render only the WebviewPreview in full screen
  if (showPreview && isPreviewMaximized) {
    return (
      <AnimatePresence>
        <motion.div 
          className="fixed inset-0 z-50 bg-background"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <WebviewPreview
            initialUrl={previewUrl}
            onClose={handleClosePreview}
            isMaximized={isPreviewMaximized}
            onToggleMaximize={handleTogglePreviewMaximize}
            onUrlChange={handlePreviewUrlChange}
            className="h-full"
          />
        </motion.div>
      </AnimatePresence>
    );
  }

  // Fire a custom event so TabContent can revert the current tab from
  // 'chat' back to 'projects'. When SessionList mutates a projects tab
  // into a chat tab on session-click, there was no way to undo that
  // mutation from within the chat view. This button is that way back.
  //
  // Also kicks off a fire-and-forget summary regen for the session
  // we're navigating away from. Auto-on-close only fires when the SDK
  // session is torn down (tab close); back-button keeps the SDK
  // session alive but we still want the summary to reflect the work
  // that just happened. Gated on the same `enabled && autoOnClose`
  // pair the lifecycle hook in main.ts checks — the back-button is
  // semantically "leaving the session," so the user's auto-on-close
  // toggle controls it. The service's in-flight dedup map prevents
  // double-spend if both back-button and tab-close fire for the same
  // session.
  const handleBackToProject = () => {
    if (claudeSessionId && projectPath) {
      // Anchor the JSONL lookup to this tab's resolved account, NOT to
      // the default ~/.claude. The configDir is held at tab level via
      // accountResolution and passed explicitly so the backend doesn't
      // have to re-resolve and risk a mismatch.
      const configDir = accountResolution?.account.config_dir ?? null;
      // Fire-and-forget; the helper reads the two global toggles and
      // skips the IPC when either is off, swallowing rejections.
      void maybeAutoGenerateSummaryOnLeave(claudeSessionId, projectPath, configDir);
    }
    window.dispatchEvent(new CustomEvent('back-to-project'));
  };

  const modeToggleDisabled = !isSessionActive || waitingForPermission || !claudeSessionId;
  const modeToggleReason = !isSessionActive
    ? 'Start a session first'
    : !claudeSessionId
      ? 'Session ID not yet available — wait a moment'
      : waitingForPermission
        ? 'Resolve the permission dialog first'
        : undefined;


  // Three-state display badge (legacy) derived from the canonical
  // SessionStatus enum + `sessionStarted` (has-the-user-ever-engaged).
  // 6→3 collapse: starting → 'starting'; idle/running/waiting_permission →
  // 'active'; stopped/error → 'ended'. Renamed from `sessionStatus` to
  // avoid colliding with the hook's canonical name.
  const displayStatus: 'starting' | 'active' | 'ended' | undefined =
    !sessionStarted
      ? undefined
      : isSessionActive
        ? 'active'
        : isSessionStarting
          ? 'starting'
          : 'ended';

  // Compute restart-button gating once so it can be passed to both the
  // header (where the button lives) and any tooltip consumers.
  const clearButtonDisabled =
    !isSessionActive || isLoading || waitingForPermission || messages.length === 0;
  const clearButtonReason = !isSessionActive
    ? 'Start a session first'
    : isLoading
      ? 'Wait for the current turn to finish'
      : waitingForPermission
        ? 'Resolve the permission dialog first'
        : messages.length === 0
          ? 'Nothing to clear'
          : undefined;

  return (
    <TooltipProvider>
      <div className={cn("flex flex-col h-full bg-background", className)}>
        <div
          ref={headerRef}
          className="relative flex items-start gap-2 px-4 py-1.5 border-b border-border/30 bg-muted shrink-0"
          style={headerHeight != null ? { height: headerHeight } : undefined}
        >
          <TooltipSimple content="Back to Project page" side="bottom">
            <Button
              size="sm"
              variant="outline"
              onClick={handleBackToProject}
              className="h-12 w-12 p-0 rounded-sm border-0 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent),2px_2px_4px_rgb(0_0_0/0.08)]"
              aria-label="Back to Project page"
            >
              <ArrowLeft className="h-6 w-6" />
            </Button>
          </TooltipSimple>
          <span aria-hidden="true" className="self-stretch w-px bg-foreground/30 shrink-0 mx-1" />
          {accountResolution && (
            <AccountCard
              accountName={accountResolution.account.name}
              accountType={accountResolution.account.account_type}
              configDir={accountResolution.account.config_dir}
              matchType={accountResolution.match_type}
              matchDetail={accountResolution.match_detail}
              sdkAccount={sdkAccountInfo}
              fiveHourRateLimit={rateLimitSnapshots.five_hour ?? null}
              sevenDayRateLimit={rateLimitSnapshots.seven_day ?? null}
              sessionStatus={displayStatus}
            />
          )}
          {gitStatus?.branch && (
            <div
              className={cn(
                "flex items-start gap-3 rounded-md border-0 bg-background/40 px-2 py-1 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent),2px_2px_4px_rgb(0_0_0/0.08)]",
                headerHeight != null && "self-stretch min-h-0",
              )}
            >
              <div className="flex flex-col items-start gap-0.5">
                <HeaderLabel>branch</HeaderLabel>
                <GitBranchBadge
                  name={gitStatus.branch}
                  changed={gitStatus.changed}
                  untracked={gitStatus.untracked}
                  color={branchColorResolution.colors[gitStatus.branch] ?? null}
                  isTrunk={branchColorResolution.trunkBlack.has(gitStatus.branch)}
                  path={projectPath}
                  error={gitStatus.error}
                />
              </div>
              {worktreeList.length > 0 && (
                <div
                  className={cn(
                    "flex flex-col items-start gap-0.5",
                    headerHeight != null && "self-stretch min-h-0",
                  )}
                >
                  <HeaderLabel>worktrees ({worktreeList.length})</HeaderLabel>
                  <div
                    className={cn(
                      "flex flex-col items-start gap-1 overflow-y-auto pr-1 scrollbar-thin",
                      headerHeight != null ? "flex-1 min-h-0" : "max-h-[5.25rem]",
                    )}
                  >
                    {worktreeList.map((wt) => {
                      const branchName = wt.branch ?? '(detached)';
                      return (
                        <div key={wt.path} title={wt.path}>
                          <GitBranchBadge
                            name={branchName}
                            changed={wt.changed}
                            untracked={wt.untracked}
                            color={branchColorResolution.colors[branchName] ?? null}
                            isTrunk={branchColorResolution.trunkBlack.has(branchName)}
                            path={wt.path}
                            error={wt.error}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {gitWatchId && (
                <div className="flex flex-col items-start gap-0.5">
                  <HeaderLabel>&nbsp;</HeaderLabel>
                  <GitWatchStatusIcon
                    errors={gitWatchErrors}
                    onReconnect={() => api.reconnectSessionGitWatch(gitWatchId)}
                    snapshotKey={sessionGit}
                  />
                </div>
              )}
            </div>
          )}
          {/* mode and output-style controls have moved to the chat bar (see FloatingPromptInput below). */}
          <SessionCard
            className="ml-auto"
            totalTokens={totalTokens}
            model={selectedModel}
            contextUsage={contextUsage}
            sessionStatus={displayStatus}
            onReconnect={() => void handleReconnect()}
            onClear={() => {
              if (window.confirm('Clear the conversation and start a fresh session? This wipes all messages in this tab and cannot be undone.')) {
                void handleClear();
              }
            }}
            clearDisabled={clearButtonDisabled}
            clearReason={clearButtonReason}
            sessionId={claudeSessionId}
          />
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize session header (double-click to reset)"
            onPointerDown={handleHeaderResizeStart}
            onDoubleClick={handleHeaderResizeReset}
            className="group absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize touch-none"
            title={headerHeight != null ? 'Drag to resize · double-click to reset' : 'Drag to resize'}
          >
            <div className="absolute left-1/2 -translate-x-1/2 bottom-0 h-0.5 w-12 rounded-full bg-foreground/15 transition-colors group-hover:bg-foreground/40" />
          </div>
        </div>
        {!sessionStarted && (
          <div className="flex-1 flex items-center justify-center p-8">
            <NewSessionForm
              accountResolution={accountResolution}
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
              effort={effort}
              setEffort={setEffort}
              thinkingConfig={thinkingConfig}
              setThinkingConfig={setThinkingConfig}
              permissionMode={permissionMode}
              setPermissionMode={setPermissionMode}
              sessionStartMode={sessionStartMode}
              setSessionStartMode={setSessionStartMode}
              onStart={() => {
                // sessionStarted is derived from sessionStatus — startPersistentSession
                // sets it to 'starting' synchronously, which flips sessionStarted true.
                logAndForget('claude-code-session:start-persistent-session', startPersistentSession());
              }}
              onChangeAccount={() => { setShowAccountPicker(true); }}
            />
          </div>
        )}
        {projectPath && (
          <AccountPickerDialog
            open={showAccountPicker}
            onOpenChange={setShowAccountPicker}
            projectPath={projectPath}
            title="Choose an account for this session"
            onAccountSelected={(account: Account) => {
              setAccountResolution({
                account: {
                  name: account.name,
                  account_type: account.account_type,
                  config_dir: account.config_dir,
                  session_defaults: account.session_defaults,
                },
                match_type: "manual_override",
                match_detail: "Selected from session form",
              });
            }}
          />
        )}
        <div className="flex-1 min-h-0 w-full flex flex-col relative">

        {/* Side panels — all positioned absolutely inside this chat-body
            wrapper so they stay within the content area (below the session
            header, above the prompt input). The messages list gets
            `sm:mr-96` to slide out of the way; the prompt input is below
            the wrapper and stays full width. Shared `panelClass` keeps
            every panel in lockstep. */}
        {(() => {
          const panelClass = "absolute right-0 top-0 bottom-0 w-full sm:w-96 bg-background border-l border-border shadow-xl z-20 overflow-hidden";
          const panelMotion = {
            initial: { x: "100%" },
            animate: { x: 0 },
            exit: { x: "100%" },
            transition: { duration: 0.2, ease: "easeOut" as const },
          };
          return (
            <>
              <AnimatePresence>
                {inspectorOpen && (
                  <motion.div {...panelMotion} className={panelClass}>
                    <SessionInspectorPanel
                      open={inspectorOpen}
                      onClose={() => { setInspectorOpen(false); }}
                      sessionId={claudeSessionId}
                      status={displayStatus}
                      sessionStatus={sessionStatus}
                      conversationStatus={conversationStatus}
                      mode={sessionMode}
                      model={selectedModel}
                      account={accountResolution ? {
                        name: accountResolution.account.name,
                        configDir: accountResolution.account.config_dir,
                      } : null}
                      projectPath={projectPath ?? null}
                      branch={gitStatus?.branch ?? null}
                      promptStatus={promptStatus}
                      mainTurnInFlight={isLoading}
                      activeAgents={activeSubagentCount}
                      tasks={{
                        total: taskListSummary.total,
                        inProgress: taskListSummary.inProgress,
                        completed: taskListSummary.done,
                        pending: taskListSummary.pending,
                      }}
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {showMCPPanel && (
                  <motion.div {...panelMotion} className={panelClass}>
                    <div className="h-full flex flex-col">
                      <div className="flex items-center justify-between p-4 border-b border-border">
                        <h3 className="text-lg font-semibold">MCP Servers</h3>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => { setShowMCPPanel(false); }}
                          className="h-8 w-8"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="flex-1 overflow-y-auto">
                        <SessionMCPStatus tabId={tabIdRef.current} />
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {showPluginsPanel && (
                  <motion.div {...panelMotion} className={panelClass}>
                    <div className="h-full flex flex-col">
                      <div className="flex items-center justify-between p-4 border-b border-border">
                        <h3 className="text-lg font-semibold">Plugins</h3>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => { setShowPluginsPanel(false); }}
                          className="h-8 w-8"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="flex-1 overflow-y-auto">
                        <SessionPluginStatus tabId={tabIdRef.current} />
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {showPermissionsPanel && (
                  <motion.div {...panelMotion} className={panelClass}>
                    <div className="h-full flex flex-col">
                      <div className="flex items-center justify-between p-4 border-b border-border">
                        <h3 className="text-lg font-semibold">Permissions</h3>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => { setShowPermissionsPanel(false); }}
                          className="h-8 w-8"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="flex-1 overflow-y-auto">
                        <SessionPermissionsEditor
                          tabId={tabIdRef.current}
                          projectPath={projectPath}
                          configDir={accountResolution?.account.config_dir || ''}
                        />
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          );
        })()}

        {/* Main Content Area */}
        <div className={cn(
          "flex-1 min-h-0 overflow-hidden transition-all duration-300 relative",
          (showMCPPanel || showPluginsPanel || showPermissionsPanel || inspectorOpen) && "sm:mr-96"
        )}>
          {/* Session Inspector toggle — top-right of the content area.
              Hidden while the panel is open (the panel has its own close X). */}
          {!inspectorOpen && (
            <button
              type="button"
              onClick={() => { setInspectorOpen(true); }}
              className="absolute top-2 right-2 z-20 rounded p-1.5 bg-background/80 backdrop-blur border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shadow-sm"
              title="Show session inspector"
              aria-label="Show session inspector"
            >
              <PanelRightOpen className="w-4 h-4" />
            </button>
          )}
          {showPreview ? (
            // Split pane layout when preview is active
            <SplitPane
              left={
                <div className="h-full flex flex-col">
                  {sessionMode === 'tui' ? (
                    <TuiSessionLayout tabId={tabIdRef.current} messagesView={messagesList} />
                  ) : (
                    messagesList
                  )}
                </div>
              }
              right={
                <WebviewPreview
                  initialUrl={previewUrl}
                  onClose={handleClosePreview}
                  isMaximized={isPreviewMaximized}
                  onToggleMaximize={handleTogglePreviewMaximize}
                  onUrlChange={handlePreviewUrlChange}
                />
              }
              initialSplit={splitPosition}
              onSplitChange={setSplitPosition}
              minLeftWidth={400}
              minRightWidth={400}
              className="h-full"
            />
          ) : (
            // Original layout when no preview
            <div className="h-full flex flex-col">
              {sessionMode === 'tui' ? (
                <TuiSessionLayout tabId={tabIdRef.current} messagesView={messagesList} />
              ) : (
                messagesList
              )}
              
              {isLoading && messages.length === 0 && (
                <div className="flex items-center justify-center h-full">
                  <div className="flex items-center gap-3">
                    <div className="rotating-symbol text-primary" />
                    <span className="text-sm text-muted-foreground">
                      {session ? "Loading session history..." : "Initializing Claude Code..."}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Queued Prompts Display — inside content area so bottom offsets are relative to scrollable region */}
          <AnimatePresence>
            {sessionStarted && queuedPrompts.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 w-full max-w-3xl px-4"
              >
                <div className="bg-background/95 backdrop-blur-md border rounded-lg shadow-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      Queued Prompts ({queuedPrompts.length})
                    </div>
                    <TooltipSimple content={queuedPromptsCollapsed ? "Expand queue" : "Collapse queue"} side="top">
                      <motion.div
                        whileTap={{ scale: 0.97 }}
                        transition={{ duration: 0.15 }}
                      >
                        <Button variant="ghost" size="icon" onClick={() => { setQueuedPromptsCollapsed(prev => !prev); }}>
                          {queuedPromptsCollapsed ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        </Button>
                      </motion.div>
                    </TooltipSimple>
                  </div>
                  {!queuedPromptsCollapsed && queuedPrompts.map((queuedPrompt, index) => (
                    <motion.div
                      key={queuedPrompt.id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.15, delay: index * 0.02 }}
                      className="flex items-start gap-2 bg-muted/50 rounded-md p-2"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-medium text-muted-foreground">#{index + 1}</span>
                          <span className="text-xs px-1.5 py-0.5 bg-primary/10 text-primary rounded">
                            {MODELS.find((m) => m.id === queuedPrompt.model)?.name ?? queuedPrompt.model}
                          </span>
                        </div>
                        <p className="text-sm line-clamp-2 break-words">{queuedPrompt.prompt}</p>
                      </div>
                      <motion.div
                        whileTap={{ scale: 0.97 }}
                        transition={{ duration: 0.15 }}
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 flex-shrink-0"
                          title="Remove from queue"
                          onClick={() => { setQueuedPrompts(prev => prev.filter(p => p.id !== queuedPrompt.id)); }}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </motion.div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

        </div>

        {/* Floating Prompt Input - Only after session started */}
        {sessionStarted && <ErrorBoundary>
          <ElicitationDialog
            open={!!elicitationRequest}
            serverName={elicitationRequest?.serverName ?? ''}
            message={elicitationRequest?.message ?? ''}
            mode={elicitationRequest?.mode}
            url={elicitationRequest?.url}
            onAccept={() => {
              logAndForget('claude-code-session:respond-elicitation', api.respondElicitation(tabIdRef.current, 'accept'));
              setElicitationRequest(null);
            }}
            onDecline={() => {
              logAndForget('claude-code-session:respond-elicitation', api.respondElicitation(tabIdRef.current, 'decline'));
              setElicitationRequest(null);
            }}
          />

          <div className={cn(
            "shrink-0 transition-all duration-300 z-50",
            // Match the Main Content Area's shrinkage so TaskList,
            // SubagentBar, and the prompt input slide out from under any
            // open side panel instead of overlaying it. Without this the
            // panel is visible behind the (translucent) bar backgrounds.
            (showMCPPanel || showPluginsPanel || showPermissionsPanel || inspectorOpen) && "sm:mr-96",
          )}>
            {pendingPermission && (
              // The SDK gates the built-in `AskUserQuestion` tool through the
              // same canUseTool / permission_request channel as Bash / Read /
              // etc. — but its right UX is "show the question with selectable
              // options", not "Allow / Deny". Render the dedicated card and
              // forward answers via updatedInput on allow. Other tools still
              // use the standard PermissionCard.
              pendingPermission.toolName === 'AskUserQuestion' ? (
                <AskUserQuestionCard
                  request={pendingPermission}
                  onSubmit={(updatedInput) => {
                    handlePermissionAllowWithInput(tabIdRef.current, updatedInput);
                  }}
                  onCancel={() => {
                    handlePermissionDeny(tabIdRef.current);
                  }}
                />
              ) : (
                <PermissionCard
                  request={pendingPermission}
                  onAllow={(selectedSuggestions) => {
                    handlePermissionAllow(
                      tabIdRef.current,
                      selectedSuggestions as PermissionSuggestion[],
                    );
                  }}
                  onDeny={() => {
                    handlePermissionDeny(tabIdRef.current);
                  }}
                />
              )
            )}
            <TaskList
              messages={messages}
              isLive={isSessionActive || isSessionStarting}
            />
            <SubagentBar
              subagents={subagents}
              onDismiss={dismissSubagent}
              onDismissAllCompleted={dismissAllCompletedSubagents}
            />
            <FloatingPromptInput
              ref={floatingPromptRef}
              onSend={fireAndLog('claude-code-session:send', handleSendPrompt)}
              onCancel={fireAndLog('claude-code-session:cancel', handleCancelExecution)}
              isLoading={isLoading}
              disabled={!projectPath}
              projectPath={projectPath}
              configDir={accountResolution?.account.config_dir}
              tabId={tabIdRef.current}
              defaultModel={selectedModel}
              effort={effort}
              onEffortChange={(level) => {
                setEffort(level);
                if (persistentSessionRef.current) {
                  const tid = tabIdRef.current;
                  api.sessionSetEffort(tid, level).catch((err: unknown) => {
                    console.error('[sessions] sessionSetEffort failed:', err);
                  });
                }
              }}
              thinkingConfig={thinkingConfig}
              onThinkingConfigChange={(config) => {
                setThinkingConfig(config);
                if (persistentSessionRef.current) {
                  const tid = tabIdRef.current;
                  const sdkConfig = config === 'adaptive'
                    ? { type: 'adaptive' as const }
                    : config === 'disabled'
                    ? { type: 'disabled' as const }
                    : { type: 'enabled' as const, budgetTokens: 10000 };
                  api.sessionSetThinking(tid, sdkConfig).catch((err: unknown) => {
                    console.error('[sessions] sessionSetThinking failed:', err);
                  });
                }
              }}
              supportedModels={supportedModels}
              supportedCommands={supportedCommands}
              onLiveModelChange={(newModel) => {
                // Wave 2.5 — clicking a model in the bottom picker updates
                // selectedModel AND, if a session is running, pushes the
                // switch to the SDK immediately via sessionSetModel() so
                // the user doesn't have to wait until the next send.
                setSelectedModel(newModel);
                if (persistentSessionRef.current) {
                  const tid = tabIdRef.current;
                  api.sessionSetModel(tid, newModel).catch((err: unknown) => {
                    console.error('[sessions] sessionSetModel failed:', err);
                  });
                }
              }}
              permissionMode={permissionMode}
              onPermissionModeChange={(mode) => {
                // Wave 2.4b — update local state AND, if a session is
                // running, push the change to the SDK via
                // sessionSetPermissionMode(). Swallow errors so a bad
                // mode doesn't revert the UI — the user can pick another.
                setPermissionMode(mode);
                if (persistentSessionRef.current) {
                  const tid = tabIdRef.current;
                  api.sessionSetPermissionMode(tid, mode).catch((err: unknown) => {
                    console.error('[sessions] sessionSetPermissionMode failed:', err);
                  });
                }
              }}
              modeToggle={
                <div className="flex items-center gap-1.5">
                  <HeaderLabel>mode</HeaderLabel>
                  <SessionModeToggle
                    mode={sessionMode}
                    onChange={(next) => {
                      api.setSessionMode(tabIdRef.current, next).catch((err: unknown) => {
                        console.error('Failed to switch mode:', err);
                        const msg = err instanceof Error ? err.message : String(err);
                        setError(`Mode switch failed: ${msg}`);
                        setTimeout(() => { setError(null); }, 5000);
                      });
                    }}
                    disabled={modeToggleDisabled}
                    disabledReason={modeToggleReason}
                  />
                </div>
              }
              outputStyleToggle={
                <div className="flex items-center gap-1.5">
                  <HeaderLabel>output style</HeaderLabel>
                  <SessionViewToggle mode={viewMode} onChange={setViewMode} />
                </div>
              }
              extraMenuItems={
                <>
                  {messages.length > 0 && (
                    <Popover
                      trigger={
                        <TooltipSimple content="Copy conversation" side="top">
                          <motion.div
                            whileTap={{ scale: 0.97 }}
                            transition={{ duration: 0.15 }}
                          >
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 bg-background text-muted-foreground hover:text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent)]"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </motion.div>
                        </TooltipSimple>
                      }
                      content={
                        <div className="w-44 p-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={fireAndLog('claude-code-session:click', handleCopyAsMarkdown)}
                            className="w-full justify-start text-xs"
                          >
                            Copy as Markdown
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={fireAndLog('claude-code-session:click', handleCopyAsJsonl)}
                            className="w-full justify-start text-xs"
                          >
                            Copy as JSONL
                          </Button>
                        </div>
                      }
                      open={copyPopoverOpen}
                      onOpenChange={setCopyPopoverOpen}
                      side="top"
                      align="end"
                    />
                  )}
                  <TooltipSimple content="MCP Servers" side="top">
                    <motion.div
                      whileTap={{ scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => { setShowMCPPanel(!showMCPPanel); if (!showMCPPanel) { setShowPluginsPanel(false); setShowPermissionsPanel(false); } }}
                        className={cn(
                          "h-8 w-8 text-muted-foreground hover:text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent)]",
                          showMCPPanel ? "bg-accent" : "bg-background",
                        )}
                      >
                        <Plug className={cn("h-3.5 w-3.5", showMCPPanel && "text-primary")} />
                      </Button>
                    </motion.div>
                  </TooltipSimple>
                  <TooltipSimple content="Plugins" side="top">
                    <motion.div
                      whileTap={{ scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => { setShowPluginsPanel(!showPluginsPanel); if (!showPluginsPanel) { setShowMCPPanel(false); setShowPermissionsPanel(false); } }}
                        className={cn(
                          "h-8 w-8 text-muted-foreground hover:text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent)]",
                          showPluginsPanel ? "bg-accent" : "bg-background",
                        )}
                      >
                        <Package className={cn("h-3.5 w-3.5", showPluginsPanel && "text-primary")} />
                      </Button>
                    </motion.div>
                  </TooltipSimple>
                  <TooltipSimple content="Permissions" side="top">
                    <motion.div
                      whileTap={{ scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => { setShowPermissionsPanel(!showPermissionsPanel); if (!showPermissionsPanel) { setShowMCPPanel(false); setShowPluginsPanel(false); } }}
                        className={cn(
                          "h-8 w-8 text-muted-foreground hover:text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent)]",
                          showPermissionsPanel ? "bg-accent" : "bg-background",
                        )}
                      >
                        <Shield className={cn("h-3.5 w-3.5", showPermissionsPanel && "text-primary")} />
                      </Button>
                    </motion.div>
                  </TooltipSimple>
                </>
              }
            />
          </div>

        </ErrorBoundary>}

      </div>

      {/* Slash Commands Settings Dialog */}
      {showSlashCommandsSettings && (
        <Dialog open={showSlashCommandsSettings} onOpenChange={setShowSlashCommandsSettings}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden">
            <DialogHeader>
              <DialogTitle>Slash Commands</DialogTitle>
              <DialogDescription>
                Manage project-specific slash commands for {projectPath}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto">
              <SlashCommandsManager projectPath={projectPath} configDir={accountResolution?.account.config_dir} />
            </div>
          </DialogContent>
        </Dialog>
      )}
      </div>
    </TooltipProvider>
  );
};
