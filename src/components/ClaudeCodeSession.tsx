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
import { MODELS } from "./ModelPicker";
import { ErrorBoundary } from "./ErrorBoundary";
import { SlashCommandsManager } from "./SlashCommandsManager";
import { SessionMCPStatus } from "./SessionMCPStatus";
import { SessionPluginStatus } from "./SessionPluginStatus";
import { PermissionCard } from "./PermissionCard";
import { ElicitationDialog } from "./ElicitationDialog";
import { SessionPermissionsEditor } from "./SessionPermissionsEditor";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { TooltipProvider, TooltipSimple } from "@/components/ui/tooltip-modern";
import { SplitPane } from "@/components/ui/split-pane";
import { WebviewPreview } from "./WebviewPreview";
import type { ClaudeStreamMessage } from "@/types/claudeStream";
import { synthesizeResultMessages } from "@/lib/synthesizeResults";
import { SessionModeToggle } from "./SessionModeToggle";
import { SessionViewToggle, type ViewMode } from "./SessionViewToggle";
import { TerminalView } from './TerminalView';
import { HiddenEventsGroup } from "./HiddenEventsGroup";
import { buildCompactItems } from "@/lib/compactGrouping";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { SessionHeader, HeaderLabel } from "./SessionHeader";
import { AccountCard } from "./AccountCard";
import { ProjectPathBadge } from "./claude-code-session/ProjectPathBadge";
import { GitBranchBadge } from "./claude-code-session/GitBranchBadge";
import { GitWatchStatusIcon } from "./claude-code-session/GitWatchStatusIcon";
import { resolveBranchColors } from '@/lib/branchColors';
import type { BranchColor } from '@/lib/api';
import { filterDisplayableMessages } from "@/lib/messageFilters";
import { deriveSubagents, isWaitingForBackground } from "@/lib/subagentStreams";
import { SubagentBar } from "./SubagentBar";
import { TodoBar } from "./TodoBar";
import { exportAsJsonl, exportAsMarkdown } from "@/lib/sessionExporters";
import { usePermissions } from "@/hooks/usePermissions";
import { useSessionLifecycle } from "@/hooks/useSessionLifecycle";
import { useSendPrompt } from "@/hooks/useSendPrompt";
// Virtualizer removed — flat list for reliable scrolling
import { SessionPersistenceService } from "@/services/sessionPersistence";

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
    autoAllowEnabled?: boolean;
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
  const [messages, setMessages] = useState<ClaudeStreamMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
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
  const [extractedSessionInfo, setExtractedSessionInfo] = useState<{ sessionId: string; projectId: string } | null>(null);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  // Wave 2.1 — SDK-reported account info, fetched after the session's
  // system:init message arrives. Used to verify end-to-end that the CLI
  // subprocess is authenticated against the account we resolved.
  const [sdkAccountInfo, setSdkAccountInfo] = useState<import('@/lib/api').SessionAccountInfo | null>(null);
  // Wave 2.2 — authoritative context-window usage from the SDK. Fetched
  // after init and at the end of every turn (result message). Replaces the
  // header's client-side (totalTokens / hardcoded limit) approximation with
  // real numbers that include system prompt + tools + memory + MCP tokens.
  const [contextUsage, setContextUsage] = useState<import('@/lib/api').SessionContextUsage | null>(null);
  // Wave 2.5 — live model list fetched via query.supportedModels() once the
  // session is running. Passed into FloatingPromptInput; when empty, its
  // picker falls back to the hardcoded MODELS array in that component.
  const [supportedModels, setSupportedModels] = useState<import('@/lib/api').SessionModelInfo[]>([]);
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
  const [sessionCost, setSessionCost] = useState(0);
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
  const [thinkingConfig, setThinkingConfig] = useState<ThinkingConfig>(initialSessionConfig?.thinkingConfig ?? 'adaptive');
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
    if (defaults.thinkingConfig) setThinkingConfig(defaults.thinkingConfig);
    if (defaults.permissionMode) setPermissionMode(defaults.permissionMode);
    if (defaults.effort) setEffort(defaults.effort as import('./FloatingPromptInput').EffortLevel);
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

    (async () => {
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
    })();

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
    const out: Array<{ label: string; error: string }> = [];
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
    waitingForPermission,
    setWaitingForPermission,
    pendingToolUse,
    setPendingToolUse,
    pendingRequestId,
    setPendingRequestId,
    autoAllowEnabled,
    setAutoAllowEnabled,
    autoAllowedTools,
    setAutoAllowedTools,
    handlePermissionAllow,
    handlePermissionDeny,
  } = usePermissions();

  // Elicitation state — MCP servers requesting user input
  const [elicitationRequest, setElicitationRequest] = useState<{
    serverName: string;
    message: string;
    mode?: 'form' | 'url';
    url?: string;
  } | null>(null);

  const parentRef = useRef<HTMLDivElement>(null);
  const persistentSessionRef = useRef(false);
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
  const floatingPromptRef = useRef<FloatingPromptInputRef>(null);
  // Tracks whether the user just hit the cancel/interrupt button. When true,
  // the stream listener suppresses the next error-typed result message (which
  // the SDK emits after interrupt) so "Execution Failed" doesn't flash after
  // a deliberate cancel. Reset after the first result message is consumed.
  const userInterruptedRef = useRef(false);
  const messagesRef = useRef<ClaudeStreamMessage[]>([]);
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
    modelChanges: [] as Array<{ from: string; to: string; timestamp: number }>,
  });

  // Call onProjectPathChange when component mounts with initial path
  useEffect(() => {
    if (onProjectPathChange && projectPath) {
      onProjectPathChange(projectPath);
    }
  }, []); // Only run on mount
  
  // Keep refs in sync with state
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Get effective session info (from prop or extracted) - use useMemo to ensure it updates
  const effectiveSession = useMemo(() => {
    if (session) return session;
    if (extractedSessionInfo) {
      return {
        id: extractedSessionInfo.sessionId,
        project_id: extractedSessionInfo.projectId,
        project_path: projectPath,
        created_at: Date.now(),
      } as Session;
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
  // Bridge the typing-bubble spinner across awaiting_background turns: while
  // a background dispatch is still running (parent turn ended, but the
  // wake-up hasn't arrived), keep the indicator alive until the next real
  // result event lands. Computed from the un-dismissed subagent set so a
  // user-dismissed background row stops driving the spinner.
  const awaitingBackground = useMemo(
    () => isWaitingForBackground(subagents),
    [subagents],
  );
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

  const [viewMode, setViewMode] = useState<ViewMode>('compact');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load session history if resuming
  useEffect(() => {
    if (session) {
      // Set the claudeSessionId immediately when we have a session
      setClaudeSessionId(session.id);

      loadSessionHistory();
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
    return () => observer.disconnect();
  }, [waitingForPermission]);

  // Calculate total tokens from messages — guard against undefined fields to avoid NaN
  useEffect(() => {
    const tokens = messages.reduce((total, msg) => {
      if (msg.message?.usage) {
        return total + (msg.message.usage.input_tokens || 0) + (msg.message.usage.output_tokens || 0);
      }
      if (msg.usage) {
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


      // Update current activity and track thinking duration based on message content
      if (message.type === 'assistant' && message.message?.content) {
        const content = Array.isArray(message.message.content) ? message.message.content : [];
        for (const block of content) {
          if (block?.type === 'thinking') {
            setCurrentActivity(pickGerund());
            break;
          } else if (block?.type === 'tool_use' && block.name) {
            // Build a descriptive label based on tool + input
            const name = block.name;
            const input = block.input || {};
            let label = `Running ${name}`;
            if (name === 'Grep') label = `Searching for ${input.pattern ? `"${String(input.pattern).slice(0, 40)}"` : 'pattern'}`;
            else if (name === 'Glob') label = `Finding files ${input.pattern ? `matching ${input.pattern}` : ''}`;
            else if (name === 'Read') label = `Reading ${input.file_path ? String(input.file_path).split('/').pop() : 'file'}`;
            else if (name === 'Write') label = `Writing ${input.file_path ? String(input.file_path).split('/').pop() : 'file'}`;
            else if (name === 'Edit' || name === 'MultiEdit') label = `Editing ${input.file_path ? String(input.file_path).split('/').pop() : 'file'}`;
            else if (name === 'Bash') label = `Running command${input.description ? `: ${String(input.description).slice(0, 60)}` : ''}`;
            else if (name === 'WebFetch') label = `Fetching ${input.url ? String(input.url).slice(0, 50) : 'URL'}`;
            else if (name === 'WebSearch') label = `Searching web${input.query ? `: "${String(input.query).slice(0, 40)}"` : ''}`;
            else if (name === 'Task') label = `Running agent${input.subagent_type ? ` (${input.subagent_type})` : ''}`;
            else if (name === 'TodoWrite') label = 'Updating todos';
            setCurrentActivity(label);
            break;
          } else if (block?.type === 'text') {
            setCurrentActivity(pickGerund());
            break;
          }
        }
      } else if (message.type === 'user' && message.message?.content) {
        const content = Array.isArray(message.message.content) ? message.message.content : [];
        if (content.some((b: any) => b?.type === 'tool_result')) {
          setCurrentActivity(pickGerund());
        }
      }

      // Store raw JSONL
      setRawJsonlOutput((prev) => [...prev, rawPayload]);

      // Track enhanced tool execution
      if (message.type === 'assistant' && message.message?.content) {
        const toolUses = message.message.content.filter((c: any) => c.type === 'tool_use');
        toolUses.forEach((toolUse: any) => {
          sessionMetrics.current.toolsExecuted += 1;
          sessionMetrics.current.lastActivityTime = Date.now();

          const toolName = toolUse.name?.toLowerCase() || '';
          if (toolName.includes('create') || toolName.includes('write')) {
            sessionMetrics.current.filesCreated += 1;
          } else if (toolName.includes('edit') || toolName.includes('multiedit') || toolName.includes('search_replace')) {
            sessionMetrics.current.filesModified += 1;
          } else if (toolName.includes('delete')) {
            sessionMetrics.current.filesDeleted += 1;
          }

        });
      }

      // Track tool results
      if (message.type === 'user' && message.message?.content) {
        const toolResults = message.message.content.filter((c: any) => c.type === 'tool_result');
        toolResults.forEach((result: any) => {
          const isError = result.is_error || false;
          if (isError) {
            sessionMetrics.current.toolsFailed += 1;
            sessionMetrics.current.errorsEncountered += 1;
          }
        });
      }

      // Track code blocks generated
      if (message.type === 'assistant' && message.message?.content) {
        const codeBlocks = message.message.content.filter((c: any) =>
          c.type === 'text' && c.text?.includes('```')
        );
        if (codeBlocks.length > 0) {
          codeBlocks.forEach((block: any) => {
            const matches = (block.text.match(/```/g) || []).length;
            sessionMetrics.current.codeBlocksGenerated += Math.floor(matches / 2);
          });
        }
      }

      // Track errors in system messages
      if (message.type === 'system' && (message.subtype === 'error' || message.error)) {
        sessionMetrics.current.errorsEncountered += 1;
      }

      // Detect permission request from SDK canUseTool callback
      if (message.type === 'permission_request' && message.request_id) {
        setPendingToolUse({
          name: message.tool_name || 'Unknown',
          input: message.tool_input || {},
          title: message.title,
          displayName: message.display_name,
          description: message.description,
          decisionReason: message.decision_reason,
          suggestions: message.permission_suggestions || [],
        });
        setPendingRequestId(message.request_id);
        setWaitingForPermission(true);
      }

      // Track cost from usage data
      if (message.usage || message.message?.usage) {
        const usage = message.usage || message.message?.usage;
        if (usage) {
          const inputCost = (usage.input_tokens || 0) * 0.000003;
          const outputCost = (usage.output_tokens || 0) * 0.000015;
          setSessionCost(prev => prev + inputCost + outputCost);
        }
      }

      // Extract session_id from system:init messages
      if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
        setClaudeSessionId(message.session_id);

        if (!extractedSessionInfo) {
          const projectId = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
          setExtractedSessionInfo({ sessionId: message.session_id, projectId });

          SessionPersistenceService.saveSession(
            message.session_id,
            projectId,
            projectPath,
            messages.length
          );
        }

        // Wave 2.1 — fetch the SDK-reported account info now that the
        // session is initialized. This is the authoritative check that
        // CLAUDE_CONFIG_DIR routed the CLI subprocess to the account we
        // think we resolved. If these disagree the SessionHeader flags it
        // so the user notices before they run anything expensive.
        const tidForAccount = tabIdRef.current;
        api.sessionAccountInfo(tidForAccount)
          .then((info) => {
            if (info) setSdkAccountInfo(info);
          })
          .catch((err) => {
            console.error('[sessions] sessionAccountInfo failed:', err);
          });

        // Wave 2.2 — also fetch the initial context-usage snapshot so the
        // header shows real numbers (system prompt / tools / memory) from
        // the very first render instead of starting at 0 and approximating.
        api.sessionContextUsage(tidForAccount)
          .then((usage) => {
            if (usage) setContextUsage(usage);
          })
          .catch((err) => {
            console.error('[sessions] sessionContextUsage failed:', err);
          });

        // Wave 2.5 — fetch the live model list for the in-session picker.
        // Only fires once per session; the result stays in state until the
        // next session init.
        api.sessionSupportedModels(tidForAccount)
          .then((models) => {
            if (models && models.length > 0) setSupportedModels(models);
          })
          .catch((err) => {
            console.error('[sessions] sessionSupportedModels failed:', err);
          });

      }

      // system:compact_boundary — SDK emits this after a manual or auto
      // compaction. The SDK's internal context is already the compacted
      // state, so refresh the header popover immediately instead of
      // waiting for the next turn's result to settle.
      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        const tidForCompact = tabIdRef.current;
        api.sessionContextUsage(tidForCompact)
          .then((usage) => {
            if (usage) setContextUsage(usage);
          })
          .catch((err) => {
            console.error('[sessions] sessionContextUsage post-compact refresh failed:', err);
          });
      }

      // system:init: skip duplicates, insert before the first user message
      if (message.type === 'system' && message.subtype === 'init') {
        const alreadyHasInit = messagesRef.current.some(
          (m) => m.type === 'system' && m.subtype === 'init'
        );
        if (alreadyHasInit) {
          return;
        }
        setMessages((prev) => {
          const firstUserIdx = prev.findIndex((m) => m.type === 'user');
          if (firstUserIdx >= 0) {
            const copy = [...prev];
            copy.splice(firstUserIdx, 0, message);
            return copy;
          }
          return [...prev, message];
        });
        return;
      }

      // result messages mean "turn complete, waiting for next input" — NOT process exit
      if (message.type === 'result') {
        // If the user just hit cancel/interrupt, the SDK emits an error-
        // typed result (is_error: true) representing the interrupted turn.
        // Suppress it so "Execution Failed" doesn't flash after a
        // deliberate cancel — the user already saw the "Response
        // interrupted" notification from handleCancelExecution.
        if (userInterruptedRef.current) {
          userInterruptedRef.current = false;
          const isError = (message as any).is_error || (message as any).subtype?.includes('error');
          if (isError) {
            setIsLoading(false);
            return;
          }
        }

        setIsLoading(false);

        // Wave 2.2 — refresh context usage at the end of every turn so the
        // header reflects the tokens this turn consumed. Fire-and-forget;
        // errors are swallowed because stale usage is strictly better than
        // breaking the turn flow.
        const tidForUsage = tabIdRef.current;
        api.sessionContextUsage(tidForUsage)
          .then((usage) => {
            if (usage) setContextUsage(usage);
          })
          .catch((err) => {
            console.error('[sessions] sessionContextUsage refresh failed:', err);
          });

        // Process queued prompts after turn completion
        if (queuedPromptsRef.current.length > 0) {
          const [nextPrompt, ...remainingPrompts] = queuedPromptsRef.current;
          setQueuedPrompts(remainingPrompts);
          setTimeout(() => {
            handleSendPrompt(nextPrompt.prompt, nextPrompt.model);
          }, 100);
        }
      }

      setMessages((prev) => [...prev, message]);
    } catch (err) {
      console.error('Failed to parse message:', err, payload);
    }
  }, [projectPath, effectiveSession, extractedSessionInfo, autoAllowedTools]);

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
    isLoading,
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
    if (initialSessionConfig?.autoAllowEnabled) {
      setAutoAllowEnabled(true);
    }
    if (session) {
      (async () => {
        const rebound = await rebindPersistentSession();
        if (!rebound) {
          await startPersistentSession(session.id);
        }
      })().catch((err) => console.error("[auto-start] resume/rebind failed:", err));
    } else if (initialSessionConfig) {
      startPersistentSession().catch((err) =>
        console.error("[auto-start] fresh start failed:", err),
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
    return () => unlisten();
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
      .catch((err) => console.error('[rate-limits] initial fetch failed:', err));

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
        .catch((err) => {
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
    return () => unlisten();
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
        message: "Response interrupted — session still active",
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

      unlistenRefs.current.forEach((unlisten) => unlisten());
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
        message: "Session cancelled by user",
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

    unlistenRefs.current.forEach((u) => u());
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
    unlistenRefs.current.forEach((unlisten) => unlisten());
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
    <div className="flex-1 min-h-0 px-10 py-2 bg-muted/30">
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
                    onResend={(text, images) => handleSendPrompt(text, selectedModel, images)}
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
                        onResend={(text, images) => handleSendPrompt(text, selectedModel, images)}
                      />
                    </div>
                  ) : (
                    <HiddenEventsGroup
                      key={item.key}
                      messages={item.messages}
                      streamMessages={messages}
                      accountType={accountResolution?.account.account_type}
                      onLinkDetected={handleLinkDetected}
                      onResend={(text, images) => handleSendPrompt(text, selectedModel, images)}
                    />
                  ),
                );
              })()}

          {/* Loading indicator under the latest message — iMessage-style typing bubble.
              Rendered inside contentRef (and before messagesEndRef) so the ResizeObserver
              on contentRef catches its appearance/height changes, and scrollIntoView on
              messagesEndRef scrolls past it instead of leaving it below the viewport.
              Also kept visible during awaiting_background so the visual "in-flight"
              cue bridges the parent's turn-end result to the eventual completion. */}
          {(isLoading || awaitingBackground) && (
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
  const handleBackToProject = () => {
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
          <Button
            size="sm"
            variant="outline"
            onClick={handleBackToProject}
            className="h-8 px-3 text-sm gap-1.5"
            title="Back to project sessions list"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Project
          </Button>
          <span aria-hidden="true" className="self-stretch w-px bg-foreground/30 shrink-0 mx-1" />
          {projectPath && (
            <div className="flex flex-col items-start gap-0.5">
              <HeaderLabel>folder</HeaderLabel>
              <ProjectPathBadge path={projectPath} />
            </div>
          )}
          {gitStatus?.branch && (
            <div className="flex flex-col items-start gap-0.5">
              <HeaderLabel>branch</HeaderLabel>
              <div className="flex items-center gap-1">
                <GitBranchBadge
                  name={gitStatus.branch}
                  changed={gitStatus.changed}
                  untracked={gitStatus.untracked}
                  color={branchColorResolution.colors[gitStatus.branch] ?? null}
                  isTrunk={branchColorResolution.trunkBlack.has(gitStatus.branch)}
                />
                {gitWatchId && (
                  <GitWatchStatusIcon
                    errors={gitWatchErrors}
                    onReconnect={() => api.reconnectSessionGitWatch(gitWatchId)}
                    snapshotKey={sessionGit}
                  />
                )}
              </div>
            </div>
          )}
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
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {/* mode and output-style controls have moved to the chat bar (see FloatingPromptInput below). */}
          {accountResolution && (
            <AccountCard
              className="ml-auto"
              accountName={accountResolution.account.name}
              configDir={accountResolution.account.config_dir}
              matchType={accountResolution.match_type}
              matchDetail={accountResolution.match_detail}
              sdkAccount={sdkAccountInfo}
              fiveHourRateLimit={rateLimitSnapshots['five_hour'] ?? null}
              sevenDayRateLimit={rateLimitSnapshots['seven_day'] ?? null}
              sessionStatus={sessionStatus}
            />
          )}
        </div>
        <SessionHeader
          accountName={accountResolution?.account.name ?? ''}
          accountType={accountResolution?.account.account_type ?? ''}
          cost={sessionCost}
          totalTokens={totalTokens}
          model={selectedModel}
          contextUsage={contextUsage}
          onClear={() => {
            if (window.confirm('Clear the conversation and start a fresh session? This wipes all messages in this tab and cannot be undone.')) {
              void handleClear();
            }
          }}
          clearDisabled={clearButtonDisabled}
          clearReason={clearButtonReason}
          onReconnect={() => void handleReconnect()}
          sessionStatus={sessionStatus}
          sessionId={claudeSessionId}
          className="mb-2"
        />
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
              autoAllowEnabled={autoAllowEnabled}
              setAutoAllowEnabled={(next) => {
                setAutoAllowEnabled(next);
                if (!next) setAutoAllowedTools(new Set());
              }}
              onStart={() => {
                setSessionStarted(true);
                startPersistentSession();
              }}
              onChangeAccount={() => setShowAccountPicker(true)}
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
                        <Button variant="ghost" size="icon" onClick={() => setQueuedPromptsCollapsed(prev => !prev)}>
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
                          onClick={() => setQueuedPrompts(prev => prev.filter(p => p.id !== queuedPrompt.id))}
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
              api.respondElicitation(tabIdRef.current, 'accept');
              setElicitationRequest(null);
            }}
            onDecline={() => {
              api.respondElicitation(tabIdRef.current, 'decline');
              setElicitationRequest(null);
            }}
          />

          <div className={cn(
            "shrink-0 transition-all duration-300 z-50",
            (showMCPPanel || showPluginsPanel || showPermissionsPanel) && "sm:mr-96"
          )}>
            {waitingForPermission && pendingToolUse && pendingRequestId && (
              <PermissionCard
                toolName={pendingToolUse.name}
                toolInput={pendingToolUse.input}
                title={pendingToolUse.title}
                displayName={pendingToolUse.displayName}
                description={pendingToolUse.description}
                decisionReason={pendingToolUse.decisionReason}
                suggestions={pendingToolUse.suggestions}
                onAllow={(selectedSuggestions) => {
                  handlePermissionAllow(tabIdRef.current, selectedSuggestions);
                }}
                onDeny={() => {
                  handlePermissionDeny(tabIdRef.current);
                }}
              />
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
              onSend={handleSendPrompt}
              onCancel={handleCancelExecution}
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
                  api.sessionSetEffort(tid, level).catch((err) => {
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
                  api.sessionSetThinking(tid, sdkConfig).catch((err) => {
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
                  api.sessionSetModel(tid, newModel).catch((err) => {
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
                  api.sessionSetPermissionMode(tid, mode).catch((err) => {
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
                      api.setSessionMode(tabIdRef.current, next).catch((err) => {
                        console.error('Failed to switch mode:', err);
                        const msg = err instanceof Error ? err.message : String(err);
                        setError(`Mode switch failed: ${msg}`);
                        setTimeout(() => setError(null), 5000);
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
                            onClick={handleCopyAsMarkdown}
                            className="w-full justify-start text-xs"
                          >
                            Copy as Markdown
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleCopyAsJsonl}
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
                    onClick={() => setShowMCPPanel(false)}
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
                    onClick={() => setShowPluginsPanel(false)}
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
                    onClick={() => setShowPermissionsPanel(false)}
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
