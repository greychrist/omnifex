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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { api, type Session, type RateLimitSnapshot, type Account } from "@/lib/api";
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
import { synthesizeResultMessages } from "@/lib/synthesizeResults";
import { maybeAutoGenerateSummaryOnLeave } from "@/lib/sessionSummaryGate";
import { SessionModeToggle } from "./SessionModeToggle";
import { SessionViewToggle, type ViewMode } from "./SessionViewToggle";
import { TerminalView } from './TerminalView';
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
import { deriveSubagents } from "@/lib/subagentStreams";
import { getLatestTodos, summarizeTodos } from "@/lib/latestTodos";
import { SubagentBar } from "./SubagentBar";
import { TodoBar } from "./TodoBar";
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";
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
import { reduceSessionStreamMessage } from "@/lib/sessionStreamReducer";
import { runStreamEffect } from "@/lib/sessionStreamEffects";
import { appendInflightDelta, clearInflightBuffer } from "@/lib/inflightCoalescer";
import { InflightAssistantBubble } from "./InflightAssistantBubble";
import { useTabSession, useClaudeSessionStore } from "@/stores/claudeSessionStore";
import type { PermissionSuggestion } from "@/lib/types/permissionRequest";

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
   * Callback to go back
   */
  onBack: () => void;
  /**
   * Callback to open hooks configuration
   */
  onProjectSettings?: (projectPath: string) => void;
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
}

/**
 * ClaudeCodeSession component for interactive Claude Code sessions
 *
 * @example
 * <ClaudeCodeSession onBack={() => setView('projects')} />
 */
export const ClaudeCodeSession: React.FC<ClaudeCodeSessionProps> = ({
  session,
  initialProjectPath = "",
  tabId,
  initialSessionConfig,
  className,
  onStreamingChange,
  onProjectPathChange,
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
  const [currentActivity, setCurrentActivity] = useState<string>("Honking");

  // Random gerund words like Claude Code CLI
  const GERUNDS = [
    "Honking", "Pondering", "Musing", "Cogitating", "Ruminating", "Brewing",
    "Noodling", "Puzzling", "Tinkering", "Scheming", "Conjuring", "Percolating",
    "Deliberating", "Contemplating", "Hatching", "Weaving", "Forging", "Crafting",
    "Kneading", "Sifting", "Plotting", "Wrangling"
  ];
  const pickGerund = () => GERUNDS[Math.floor(Math.random() * GERUNDS.length)];
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
  const [sessionStarted, setSessionStarted] = useState(!!session || !!initialSessionConfig);
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
  // Unified per-tab git snapshot — project + all sibling worktrees streamed
  // from a single main-process watcher. Null until `startSessionGitWatch`
  // resolves; stays null when the project isn't a git repo.
  const [sessionGit, setSessionGit] = useState<import('@/lib/api').SessionGitSnapshot | null>(null);
  const [gitWatchId, setGitWatchId] = useState<string | null>(null);
  const [branchPins, setBranchPins] = useState<Record<string, string>>({});

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
  // but only for new sessions (not when resuming or launched with explicit config).
  const accountDefaultsApplied = useRef(false);
  useEffect(() => {
    if (!accountResolution || accountDefaultsApplied.current || sessionStarted) return;
    const defaults = accountResolution.account.session_defaults;
    if (!defaults) return;
    accountDefaultsApplied.current = true;
    if (defaults.model) setSelectedModel(defaults.model);
    if (defaults.thinkingConfig) setThinkingConfig(normalizeThinkingConfig(defaults.thinkingConfig));
    if (defaults.permissionMode) setPermissionMode(defaults.permissionMode);
    if (defaults.effort) setEffort(defaults.effort);
  }, [accountResolution, sessionStarted]);

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
  const worktreeList = sessionGit?.worktrees ?? [];
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
  // queue gate. The drain path (setTimeout in runStreamEffect) holds onto a
  // captured handleSendPrompt across renders; reading from the ref avoids
  // the stale-closure bug where drained prompts silently re-queue.
  const isLoadingRef = useRef(false);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);
  // Two distinct states for the status badge:
  //  - isSessionStarting: true between api.startSession firing and the SDK
  //    control channel answering. Maps to 'Starting…' in the header.
  //  - isSessionActive: true once fetchInitInfo receives a response (account
  //    info, MCP tools). Maps to 'Active'.
  // persistentSessionRef stays the source of truth for synchronous checks
  // inside async handlers (e.g. whether to start a session on first prompt);
  // these states are the UI-reactive mirror so the badge rerenders.
  const [isSessionStarting, setIsSessionStarting] = useState(false);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [sessionMode, setSessionMode] = useState<'sdk' | 'tui'>('sdk');
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

  // Call onProjectPathChange when component mounts with initial path
  useEffect(() => {
    if (onProjectPathChange && projectPath) {
      onProjectPathChange(projectPath);
    }
  }, []); // Only run on mount

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
  const [dismissedSubagents, setDismissedSubagents] = useState<Set<string>>(new Set());
  const subagents = useMemo(() => {
    const all = deriveSubagents(messages);
    return dismissedSubagents.size === 0
      ? all
      : all.filter((s) => !dismissedSubagents.has(s.toolUseId));
  }, [messages, dismissedSubagents]);
  // Typing bubble used to bridge on `hasRunningSubagent(subagents)` so a
  // stuck-running row would keep the spinner on after `isLoading` flipped
  // false. That coupled visual session activity to outstanding-subagent
  // state and faked a live turn whenever the subagent-tracking pipeline
  // missed a closure carrier. Decoupled now — the bubble follows
  // `isLoading` (driven by SDK turn state) and `todosInFlight`. The
  // SubagentBar's per-row spinner remains the scoped indicator that a
  // particular dispatch is in flight. See design spec
  // docs/superpowers/specs/2026-05-11-subagent-tracking-refactor-design.md.
  // True iff the latest todo list still has pending or in_progress items.
  // Folded into the spinner gate so the in-tab indicator matches the
  // popover's "busy" definition (turn || agents || todos).
  const todosInFlight = useMemo(() => {
    const todos = getLatestTodos(messages);
    if (!todos) return false;
    return summarizeTodos(todos).running;
  }, [messages]);
  // True when the streaming bubble is currently rendered. Used to
  // suppress the typing-dots spinner so the spinner and bubble
  // don't co-exist on screen.
  const hasInflightAssistant = useClaudeSessionStore(
    (s) => s.tabs[tabIdRef.current]?.inflightAssistant != null,
  );
  const outstandingWork = isLoading || todosInFlight;
  const dismissSubagent = useCallback((toolUseId: string) => {
    setDismissedSubagents((prev) => {
      const next = new Set(prev);
      next.add(toolUseId);
      return next;
    });
  }, []);
  const dismissAllCompletedSubagents = useCallback(() => {
    setDismissedSubagents((prev) => {
      const next = new Set(prev);
      for (const s of subagents) {
        if (s.status !== 'running') next.add(s.toolUseId);
      }
      return next;
    });
  }, [subagents]);

  // Publish this tab's busy/idle summary up to main on every change. The
  // status popover and the install-gate both read from the aggregated list.
  const { getTabById } = useTabContext();
  const tabTitle = getTabById(tabIdRef.current)?.title ?? projectPath ?? tabIdRef.current;
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

  const [viewMode, setViewMode] = useState<ViewMode>('compact');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load session history if resuming
  useEffect(() => {
    if (session) {
      // Set the claudeSessionId immediately when we have a session
      setClaudeSessionId(session.id);

      logAndForget('claude-code-session:load-session-history', loadSessionHistory());
    }
  }, [session]);

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

  const loadSessionHistory = async () => {
    if (!session) return;
    
    try {
      setIsLoading(true);
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
      
      // Convert history to messages format. JSONL entries carry their own
      // `timestamp` field per line — map it to `receivedAt` so the card
      // timestamp badge renders for resumed sessions just like for live ones.
      const loadedMessages: ClaudeStreamMessage[] = history.map(entry => ({
        ...entry,
        type: entry.type || "assistant",
        receivedAt: entry.receivedAt ?? entry.timestamp,
      }));

      // The Claude CLI's JSONL session file does not persist live SDK
      // `result` messages. Synthesize them from per-turn data so the
      // "Execution Complete" card appears for every completed turn when a
      // session is resumed. Live sessions are unaffected — this only runs
      // on the historical load.
      const messagesWithResults = synthesizeResultMessages(loadedMessages);

      setMessages(messagesWithResults);
      setRawJsonlOutput(history.map(h => JSON.stringify(h)));
      
      // Scroll to bottom after loading history
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      }, 100);
    } catch (err) {
      console.error("Failed to load session history:", err);
      setError("Failed to load session history");
    } finally {
      setIsLoading(false);
    }
  };

  // Helper to process any JSONL stream message string or object
  const handleStreamMessage = useCallback((payload: string | ClaudeStreamMessage) => {
    try {
      // Don't process if component unmounted
      if (!isMountedRef.current) return;

      let message: ClaudeStreamMessage;
      let rawPayload: string;

      if (typeof payload === 'string') {
        rawPayload = payload;
        message = JSON.parse(payload) as ClaudeStreamMessage;
      } else {
        message = payload;
        rawPayload = JSON.stringify(payload);
      }


      // stream_event: token-level partial assistant message.
      // Filter to text-only deltas from the parent agent and route through
      // the coalescer. Subagent partials and non-text deltas drop. Early-
      // return BEFORE setRawJsonlOutput because (a) these are ephemeral
      // partials the SDK doesn't persist, and (b) per-token state thrash
      // on this component is the exact perf cost the RAF coalescer exists
      // to avoid.
      if (message.type === 'stream_event') {
        const m = message as any;
        if (m.parent_tool_use_id != null) return; // skip subagent partials (null OR undefined)
        const event = m.event;
        if (
          event?.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          typeof event.delta.text === 'string'
        ) {
          appendInflightDelta(
            tabIdRef.current,
            m.uuid,
            event.delta.text,
            m.parent_tool_use_id,
          );
        }
        return;
      }

      // Store raw JSONL
      setRawJsonlOutput((prev) => [...prev, rawPayload]);

      // Pure reducer handles: append decisions, session-id extraction,
      // permission detection, userInterrupted suppression, init dedup,
      // result-turn handling, post-event refresh requests, AND activity
      // labels, metrics, cost. Read live tab state from the store so the
      // reducer sees the post-batch values, not the render-time closure.
      const liveSlice = useClaudeSessionStore
        .getState()
        .selectTab(sessionTabId);
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

      // Activity label
      if (reduced.activityUpdate) {
        setCurrentActivity(
          reduced.activityUpdate.kind === 'literal'
            ? reduced.activityUpdate.label
            : pickGerund(),
        );
      }

      // Metric deltas — fold into the live ref. Snap lastActivityTime to
      // now when the message implied activity.
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
        setClaudeSessionId(reduced.sessionIdUpdate);
      }
      if (reduced.extractedSessionInfo) {
        setExtractedSessionInfo(reduced.extractedSessionInfo);
      }
      if (reduced.pendingPermission) {
        setPendingPermission(reduced.pendingPermission);
      }
      if (reduced.clearUserInterrupted) {
        userInterruptedRef.current = false;
      }
      if (reduced.clearLoading) {
        setIsLoading(false);
      }

      // Execute returned effects. Effects are intentionally fire-and-forget;
      // errors are logged but never break the stream.
      for (const effect of reduced.effects) {
        runStreamEffect(effect, {
          tabId: tabIdRef.current,
          projectPath,
          api: {
            sessionAccountInfo: api.sessionAccountInfo,
            sessionContextUsage: api.sessionContextUsage,
            sessionSupportedModels: api.sessionSupportedModels,
          },
          persistSession: ({ sessionId, projectId, projectPath: pp, messageCount }) =>
            { SessionPersistenceService.saveSession(sessionId, projectId, pp, messageCount); },
          setSdkAccountInfo: (info) => { setSdkAccountInfo(info as any); },
          setContextUsage: (usage) => { setContextUsage(usage as any); },
          setSupportedModels: (models) => { setSupportedModels(models as any); },
          queuedPromptsRef,
          setQueuedPrompts,
          handleSendPrompt: fireAndLog('claude-code-session:send-prompt-effect', handleSendPrompt),
          onError: (kind, err) =>
            { console.error(`[sessions] effect ${kind} failed:`, err); },
        });
      }

      // Reconcile inflight slot:
      //  - On any assistant append, the canonical complete message has landed;
      //    clear the inflight slot and any unflushed deltas so the streaming
      //    bubble unmounts as the canonical bubble in messages[] takes its place.
      //  - On any error notification, clear so the streaming bubble doesn't
      //    sit stale next to an error card.
      const store = useClaudeSessionStore.getState();
      if (reduced.append === 'append' && message.type === 'assistant') {
        store.clearInflightAssistant(tabIdRef.current);
        clearInflightBuffer(tabIdRef.current);
      }
      if (
        message.type === 'system' &&
        message.subtype === 'notification' &&
        // notification_type isn't typed yet — see the Tier B follow-up in
        // the audit. Cast stays until that lands.
        /error/i.test(String((message as any).notification_type ?? ''))
      ) {
        store.clearInflightAssistant(tabIdRef.current);
        clearInflightBuffer(tabIdRef.current);
      }

      // Fold the message into messages[] per the reducer's append decision.
      if (reduced.append === 'skip') {
        return;
      }
      if (reduced.append === 'insertBeforeFirstUser') {
        insertMessageBeforeFirstUser(message);
        return;
      }
      appendMessage(message);
    } catch (err) {
      console.error('Failed to parse message:', err, payload);
    }
  }, [projectPath, effectiveSession, extractedSessionInfo]);

  // Session lifecycle: persistent session management, event listeners, cleanup
  const { unlistenRefs, isMountedRef, startPersistentSession, rebindPersistentSession } = useSessionLifecycle({
    tabId: tabIdRef.current,
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
    if (persistentSessionRef.current) return;
    if (session) {
      (async () => {
        const rebound = await rebindPersistentSession();
        if (!rebound) {
          await startPersistentSession(session.id);
        }
      })().catch((err: unknown) => { console.error("[auto-start] resume/rebind failed:", err); });
    } else if (initialSessionConfig) {
      startPersistentSession().catch((err: unknown) =>
        { console.error("[auto-start] fresh start failed:", err); },
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
          const loaded: ClaudeStreamMessage[] = history.map((entry: any) => ({
            ...entry,
            type: entry.type || 'assistant',
            receivedAt: entry.receivedAt ?? entry.timestamp,
          }));
          setMessages(synthesizeResultMessages(loaded));
        })
        .catch((err: unknown) => {
          console.error('Failed to reload history on TUI->SDK:', err);
        });
    };
  }, [claudeSessionId, extractedSessionInfo, projectPath]);

  // Listen for session mode changes from main process
  useEffect(() => {
    const unlisten = window.electronAPI.onEvent(
      `session-mode:${tabIdRef.current}`,
      (...args: unknown[]) => {
        const payload = args[0] as { mode?: 'sdk' | 'tui' } | undefined;
        if (payload?.mode === 'sdk' || payload?.mode === 'tui') {
          setSessionMode(payload.mode);
          // A mode switch means the main process has a live session handle
          // on the other side of the toggle. Keep the header badge 'Active'
          // rather than dropping back to 'Starting…' while the restarted
          // SDK query waits for its first message.
          setIsSessionActive(true);
          // On return to SDK mode, reload history from the JSONL file.
          // TUI-mode turns wrote to the session file but never flowed
          // through our claude-output events, so they're missing from
          // messages[]. The ref indirection keeps this stable across
          // the effect's [] deps while reading live state.
          if (payload.mode === 'sdk') reloadHistoryRef.current();
        }
      },
    );
    return () => { unlisten(); };
  }, []);

  // Keep queuedPromptsRef in sync with state
  useEffect(() => {
    queuedPromptsRef.current = queuedPrompts;
  }, [queuedPrompts]);

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
      setIsSessionStarting(false);
      setIsSessionActive(false);
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

    // Best-effort stop of any zombie main-process session for this tab so
    // start() doesn't trip its existing-session-cleanup path on a half-dead
    // handle.
    try { await api.stopSession(tid); } catch { /* best effort */ }

    unlistenRefs.current.forEach((u) => { u(); });
    unlistenRefs.current = [];

    persistentSessionRef.current = false;
    setIsSessionStarting(false);
    setIsSessionActive(false);
    setIsLoading(false);
    setError(null);

    // Try the cheap rebind first — if the main process session was already
    // restarted by a hot reload the rebind succeeds and we're done.
    const rebound = await rebindPersistentSession().catch(() => false);
    if (rebound) return;

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
    setIsSessionStarting(false);
    setIsSessionActive(false);
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
                    onResend={fireAndLog('claude-code-session:resend', (text, images) => handleSendPrompt(text, selectedModel, images))}
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
                        onResend={fireAndLog('claude-code-session:resend', (text, images) => handleSendPrompt(text, selectedModel, images))}
                      />
                    </div>
                  ) : (
                    <HiddenEventsGroup
                      key={item.key}
                      messages={item.messages}
                      streamMessages={messages}
                      accountType={accountResolution?.account.account_type}
                      onLinkDetected={handleLinkDetected}
                      onResend={fireAndLog('claude-code-session:resend', (text, images) => handleSendPrompt(text, selectedModel, images))}
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

  const modeToggleDisabled = !isSessionActive || waitingForPermission;
  const modeToggleReason = !isSessionActive
    ? 'Start a session first'
    : waitingForPermission
      ? 'Resolve the permission dialog first'
      : undefined;


  const sessionStatus: 'starting' | 'active' | 'ended' | undefined =
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
        <div className="flex items-start gap-2 px-4 py-1.5 border-b border-border/30 bg-muted shrink-0">
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
              sessionStatus={sessionStatus}
            />
          )}
          {gitStatus?.branch && (
            <div className="flex items-start gap-3 rounded-md border-0 bg-background/40 px-2 py-1 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent),2px_2px_4px_rgb(0_0_0/0.08)]">
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
                <div className="flex flex-col items-start gap-0.5">
                  <HeaderLabel>worktrees</HeaderLabel>
                  <div className="flex flex-col items-start gap-1">
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
            sessionStatus={sessionStatus}
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
              onStart={() => {
                setSessionStarted(true);
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

        {/* Main Content Area */}
        <div className={cn(
          "flex-1 min-h-0 overflow-hidden transition-all duration-300 relative",
          (showMCPPanel || showPluginsPanel || showPermissionsPanel) && "sm:mr-96"
        )}>
          {showPreview ? (
            // Split pane layout when preview is active
            <SplitPane
              left={
                <div className="h-full flex flex-col">
                  {sessionMode === 'tui' ? (
                    <TerminalView tabId={tabIdRef.current} />
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
                <TerminalView tabId={tabIdRef.current} />
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
            (showMCPPanel || showPluginsPanel || showPermissionsPanel) && "sm:mr-96"
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
            <TodoBar
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

        {/* MCP Servers Panel */}
        <AnimatePresence>
          {showMCPPanel && (
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="fixed right-0 top-0 h-full w-full sm:w-96 bg-background border-l border-border shadow-xl z-30 overflow-hidden"
            >
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

        {/* Plugins Panel */}
        <AnimatePresence>
          {showPluginsPanel && (
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="fixed right-0 top-0 h-full w-full sm:w-96 bg-background border-l border-border shadow-xl z-30 overflow-hidden"
            >
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

        {/* Permissions Panel */}
        <AnimatePresence>
          {showPermissionsPanel && (
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="fixed right-0 top-0 h-full w-full sm:w-96 bg-background border-l border-border shadow-xl z-30 overflow-hidden"
            >
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
