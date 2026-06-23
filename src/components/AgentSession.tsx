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
import { api, type Session, type RateLimitSnapshot, type Account, type ResolvePair, type SessionMode } from "@/lib/api";
import { cn } from "@/lib/utils";
import { NewSessionForm } from "./NewSessionForm";
import { AccountPickerDialog } from "./AccountPickerDialog";
import { CodexSignInModal } from "@/components/codex/CodexSignInModal";
import { useCodexAuthStatus } from "@/hooks/useCodexAuthStatus";
import { ClaudeTranscript } from "@/components/claude/ClaudeTranscript";
import { CodexTranscript } from "@/components/codex/CodexTranscript";
import type { AgentMessage } from "@/lib/api";
import {
  FloatingPromptInput,
  type FloatingPromptInputRef,
  type EffortLevel,
  type ThinkingConfig,
} from "./FloatingPromptInput";
import { normalizeThinkingConfig } from "@/lib/thinkingConfig";
import { modelDisplayName } from "@/lib/modelCatalog";
import { SessionDefaultsRow } from "@/components/shared/SessionDefaultsRow";
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
import type { JsonlNode } from "@/types/jsonl";
import { normalizeJsonlNode } from "@/lib/normalizeMessage";
import { classifyJsonlLine } from '@/lib/jsonlClassifier';
import { lastPermissionMode } from '@/lib/sessionDerivedState';
import { reduceSessionStreamMessage } from '@/lib/sessionStreamReducer';
import { runStreamEffect } from '@/lib/sessionStreamEffects';
import { appendInflightDelta } from '@/lib/inflightCoalescer';
import { maybeAutoGenerateSummaryOnLeave } from "@/lib/sessionSummaryGate";
import { SessionModeToggle } from "./SessionModeToggle";
import { SessionViewToggle, type ViewMode } from "./SessionViewToggle";
import { TuiSessionLayout } from './TuiSessionLayout';
import { createTuiPromptHandler } from '@/lib/tuiPromptHandler';
// deriveConversationStatus import removed — derivation moved into useSessionLifecycle (Task 2).
import { HeaderLabel } from "./HeaderLabel";
import { AccountCard } from "./AccountCard";
import { SessionCard } from "./SessionCard";
import { GitBranchBadge } from "./claude-code-session/GitBranchBadge";
import { GitWatchStatusIcon } from "./claude-code-session/GitWatchStatusIcon";
import { resolveBranchColors } from '@/lib/branchColors';
import type { BranchColor } from '@/lib/api';
import { deriveSubagents, createSubagentColorAllocator } from "@/lib/subagentStreams";
import { getTaskList, summarizeTaskList } from "@/lib/taskList";
import { deriveWaitingFor, type TabWaitingFor } from "@/lib/tabWaitingFor";
import { SubagentBar } from "./SubagentBar";
import { TaskList } from "./claude/tools/TaskList";
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";
import { decideAutoStart } from "@/lib/sessionAutoStart";
import { exportAsJsonl, exportAsMarkdown } from "@/lib/sessionExporters";
import { usePermissions } from "@/hooks/usePermissions";
import { useSessionLifecycle } from "@/hooks/useSessionLifecycle";
import { useSendPrompt } from "@/hooks/useSendPrompt";
import { usePublishTabStatus } from "@/hooks/usePublishTabStatus";
import { useTabContext } from "@/contexts/TabContext";
// Virtualizer removed — flat list for reliable scrolling
import { SessionPersistenceService } from "@/services/sessionPersistence";
import { clearInflightBuffer } from "@/lib/inflightCoalescer";
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

interface AgentSessionProps {
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
        subscription_label: string;
        has_cost: boolean;
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
 * AgentSession — the chrome around a live agent session (Claude today, Codex
 * in the future). Owns project/session lifecycle, account resolution, prompt
 * input, status bar, and the side panels. The per-agent transcript body is
 * delegated to a transcript component (currently `ClaudeTranscript`).
 */
export const AgentSession: React.FC<AgentSessionProps> = ({
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
  // Parallel transcript buffer for Codex tabs. The shared `agent-output:`
  // channel carries both Claude stream-json (handled by `handleJsonlLine`
  // via the JSONL classifier) and Codex notifications (shape `{ method,
  // params }`). The classifier returns null for the Codex shape — fine for
  // Claude tabs — but Codex tabs need a transcript, so we collect a
  // separate `codexMessages` array off the same channel. A future pass may
  // consolidate the two accumulators behind a single reducer; for now the
  // parallel buffer keeps Task 19 a zero-touch change to the Claude reducer.
  const [codexMessages, setCodexMessages] = useState<AgentMessage[]>([]);
  const [copyPopoverOpen, setCopyPopoverOpen] = useState(false);
  const [totalTokens, setTotalTokens] = useState(0);
  // The account's resolved default model from its settings.json (`model` key,
  // e.g. "opus[1m]"). When the context gauge is on its client-side fallback —
  // e.g. a resumed session before its next turn (history loads statically, so
  // live usage isn't fetched), or a TUI session — an "Account Default"
  // session's own model string carries no [1m] suffix, so this is the only
  // signal that the resolved default is a 1M model. Feeds the fallback
  // denominator. See resolveContextLimit.
  const [accountDefaultModel, setAccountDefaultModel] = useState<string | null>(null);
  // Pre-fetched built-in slash commands from the CLI, loaded alongside models
  // during session init so the picker has them immediately.
  const [supportedCommands, setSupportedCommands] = useState<import('@/lib/api').SessionSlashCommand[]>([]);
  const [showMCPPanel, setShowMCPPanel] = useState(false);
  const [showPluginsPanel, setShowPluginsPanel] = useState(false);
  const [showPermissionsPanel, setShowPermissionsPanel] = useState(false);

  const [showSlashCommandsSettings, setShowSlashCommandsSettings] = useState(false);
  const [accountResolution, setAccountResolution] = useState<{
    account: { name: string; subscription_label: string; has_cost: boolean; config_dir: string; session_defaults?: import('@/lib/api').SessionDefaults };
    match_type: string;
    match_detail: string;
  } | null>(initialSessionConfig?.accountResolution ?? null);
  // Mirror accountResolution into a ref so loadSessionHistory can read the
  // account's default permission mode without taking accountResolution as a
  // dependency (which would re-trigger a history reload when it resolves).
  const accountResolutionRef = useRef(accountResolution);
  accountResolutionRef.current = accountResolution;
  const [showAccountPicker, setShowAccountPicker] = useState(false);
  // Codex sign-in modal toggle, driven by the inline banner on the
  // new-session form. The auth status itself comes from useCodexAuthStatus
  // so the banner re-renders the moment `~/.codex/auth.json` lands.
  const [showCodexSignIn, setShowCodexSignIn] = useState(false);

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
  const [selectedModel, setSelectedModel] = useState<string>(initialSessionConfig?.model ?? "opus");
  // Permission mode — the full CLI set ("default" | "acceptEdits" | "plan"
  // | "bypassPermissions"). Pre-session and in-session pickers both use
  // the same PERMISSION_MODES constant from FloatingPromptInput.
  // Default is acceptEdits per user preference — safer than bypass,
  // smoother than ask-every-time.
  const [permissionMode, setPermissionMode] = useState<string>(initialSessionConfig?.permissionMode ?? "acceptEdits");
  // Effort level — maps to the CLI's reasoning_effort parameter.
  // Default 'high' matches the CLI's own default (EffortLevel docs).
  // There is no 'auto' — the CLI's EffortLevel is strictly low/medium/high/xhigh/max.
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
  // Agent picker — early `useTabContext` call (the main one further down
  // is for tabTitle / updateTab; both consume the same context, so no
  // ordering hazard). The form-level state seeds from `tab.agent` so a
  // resumed-or-restored chat tab keeps its engine identity. The setter
  // updates the tab record on each change so other readers (session
  // start dispatch, session-list partition, header indicator) see it.
  const tabContextForAgent = useTabContext();
  const initialAgentFromTab: import('@/lib/api').AgentKind =
    tabContextForAgent.getTabById(tabId || 'default')?.agent ?? 'claude';
  const [agent, setAgentLocal] = useState<import('@/lib/api').AgentKind>(initialAgentFromTab);
  const setAgent = useCallback((next: import('@/lib/api').AgentKind) => {
    setAgentLocal(next);
    tabContextForAgent.updateTab(tabId || 'default', { agent: next });
  }, [tabContextForAgent, tabId]);
  // Codex auth status, scoped to the resolved account's configDir on the
  // Codex path only. The status itself comes from useCodexAuthStatus so the
  // new-session banner re-renders the moment `~/.codex/auth.json` lands. Pass
  // null on the Claude path to disable the watcher entirely.
  const codexAuthStatus = useCodexAuthStatus(
    agent === 'codex' ? (accountResolution?.account.config_dir ?? null) : null,
  );
  // Adapt this tab's single resolved account into the per-engine ResolvePair
  // shape NewSessionForm now consumes. AgentSession only tracks one resolved
  // account (the active tab's), so it lands in the slot for the current
  // engine; the other slot is null. The form only reads `account.name`, so the
  // synthesized Account fields beyond name/config_dir/subscription_label are
  // placeholders, never displayed.
  const resolvePair = useMemo<ResolvePair>(() => {
    if (!accountResolution) return { claude: null, codex: null };
    const a = accountResolution.account;
    const account: Account = {
      id: -1,
      name: a.name,
      config_dir: a.config_dir,
      engine: agent,
      subscription_label: a.subscription_label,
      has_cost: false,
      color: null,
      icon: null,
      session_defaults: a.session_defaults,
      cli_path: null,
      created_at: '',
      updated_at: '',
    };
    const slot = {
      account,
      matchType: accountResolution.match_type === 'override' ? 'override' as const : 'path_rule' as const,
      matchDetail: accountResolution.match_detail,
    };
    return agent === 'codex' ? { claude: null, codex: slot } : { claude: slot, codex: null };
  }, [accountResolution, agent]);
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
      api.explainAccountResolution(projectPath, agent).then((result) => {
        if (result) {
          setAccountResolution(result);
        }
      }).catch(console.error);
    }
  }, [projectPath, hasInitialAccountOverride, agent]);

  // Resolve the account's default model from its settings.json so the
  // context-gauge fallback can size a 1M-context "Account Default" session
  // correctly (the live window is unavailable in TUI mode, and the session's
  // own model string never carries the [1m] suffix). Re-reads on account
  // change rather than persisting, so a later settings.json edit isn't stale.
  const accountConfigDir = accountResolution?.account.config_dir ?? null;
  useEffect(() => {
    if (!accountConfigDir) { setAccountDefaultModel(null); return; }
    let cancelled = false;
    api.getClaudeSettings({ configDir: accountConfigDir })
      .then((settings) => {
        if (cancelled) return;
        const m = (settings as { model?: unknown } | null)?.model;
        setAccountDefaultModel(typeof m === 'string' ? m : null);
      })
      .catch(() => { if (!cancelled) setAccountDefaultModel(null); });
    return () => { cancelled = true; };
  }, [accountConfigDir]);

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
  // the CLI emits after interrupt) so "Execution Failed" doesn't flash after
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
  // `isLoading` (driven by CLI turn state) and `tasksInFlight`. The
  // SubagentBar's per-row spinner remains the scoped indicator that a
  // particular dispatch is in flight. See design spec
  // docs/superpowers/specs/2026-05-11-subagent-tracking-refactor-design.md.
  // True when the streaming bubble is currently rendered. Used to
  // suppress the typing-dots spinner so the spinner and bubble
  // don't co-exist on screen.
  const hasInflightAssistant = useClaudeSessionStore(
    (s) => s.tabs[tabIdRef.current]?.inflightAssistant != null,
  );
  // Raw task list entries — null (no task-list tool used yet) normalised to [].
  // Defined here so tasksInFlight can derive from it without a second getTaskList call.
  // The same reference is passed to useSessionLifecycle further down.
  const taskEntries = useMemo(() => getTaskList(messages) ?? [], [messages]);
  // True iff the latest task list has an actively in_progress item. Pending
  // (planned-but-unstarted) tasks do NOT count — otherwise a resumed session
  // that ended with unstarted todos shows a spinner forever. Matches
  // hasOpenTasks in sessionDerivedState.ts (the conversationStatus path).
  const tasksInFlight = useMemo(
    () => summarizeTaskList(taskEntries).inProgress > 0,
    [taskEntries],
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
  // taskEntries is defined above (alongside tasksInFlight) so both can share a single getTaskList call.
  const taskListSummary = useMemo(() => {
    return taskEntries.length > 0
      ? summarizeTaskList(taskEntries)
      : { total: 0, done: 0, inProgress: 0, pending: 0, running: false };
  }, [taskEntries]);

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

  // Approximate current context-window occupancy from the LAST assistant turn.
  // This is the fallback the SessionCard uses when the CLI's live
  // query.getContextUsage() isn't available yet (notably right after a resume).
  // Summing input+output across every turn would be cumulative tokens
  // generated over the whole session — far larger than the live context — so
  // we read only the most recent assistant message's usage:
  //   input + cache_read + cache_creation + output ≈ what was in context.
  useEffect(() => {
    let last: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.kind === 'assistant') {
        const usage = msg.raw.message?.usage as typeof last;
        if (usage) { last = usage; break; }
      }
    }
    const tokens = last
      ? (last.input_tokens || 0)
        + (last.cache_read_input_tokens || 0)
        + (last.cache_creation_input_tokens || 0)
        + (last.output_tokens || 0)
      : 0;
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

      // Route through the JSONL classifier. The classifier normalizes
      // timestamp→receivedAt and discriminates every line into a typed
      // JsonlNode. normalizeJsonlNode handles string→array content for
      // assistant/user nodes so downstream consumers can assume array form.
      const nodes: JsonlNode[] = history
        .map((entry) => classifyJsonlLine(entry))
        .filter((n): n is NonNullable<typeof n> => n !== null)
        .map((n) => normalizeJsonlNode(n));

      streamCtxRef.current.setMessages(nodes);
      setRawJsonlOutput(history.map(h => JSON.stringify(h)));

      // Restore the permission mode the session was last in (resume fidelity).
      // Priority: last mode recorded in the JSONL → account default → leave the
      // hardcoded initial fallback (acceptEdits). setPermissionMode is a stable
      // setter so it's safe to call here without a dependency.
      const resumedMode =
        lastPermissionMode(nodes)
        ?? accountResolutionRef.current?.account.session_defaults?.permissionMode;
      if (resumedMode) setPermissionMode(resumedMode);

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
      // Codex variants ride the same channel with `kind: 'patch' | 'exec'`,
      // `agent: 'codex'`, and the raw approval params on `codex_payload`.
      if (raw && typeof raw === 'object' && (raw as any).type === 'permission_request') {
        const msg = raw as any;
        setPendingPermission({
          requestId: msg.request_id,
          kind: msg.kind,
          toolName: msg.tool_name,
          toolInput: msg.tool_input ?? {},
          title: msg.title,
          displayName: msg.display_name,
          description: msg.description,
          decisionReason: msg.decision_reason,
          blockedPath: msg.blocked_path,
          suggestions: msg.permission_suggestions ?? [],
          agent: msg.agent,
          summary: msg.summary,
          payload: msg.codex_payload,
        });
        return;
      }

      // stream_event — CLI iterator overlay channel (token partials).
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

      // Classify. The classifier normalizes the raw JSONL line into a
      // typed JsonlNode. normalizeJsonlNode handles string→array content
      // for assistant/user nodes. Overlay kinds (stream-event, rate-limit,
      // lifecycle) return null from the classifier and are skipped.
      const node = classifyJsonlLine(raw);
      if (!node) return;
      // Overlay kinds never enter messages[]; skip them here too.
      if (node.kind === 'stream-event' || node.kind === 'rate-limit' || node.kind === 'lifecycle') return;
      const normalizedNode = normalizeJsonlNode(node);

      // Store raw line.
      setRawJsonlOutput((prev) => [...prev, rawString]);

      const ctx = streamCtxRef.current;

      // The node goes through the reducer for its side effects:
      // activity labels, metrics, cost, session-id extraction,
      // userInterrupted suppression, post-event refresh effects,
      // and the append/skip/insert decision. The reducer is pure.
      {
        const message = normalizedNode;
        const liveSlice = useClaudeSessionStore.getState().selectTab(sessionTabId);
        const hasExistingInit = liveSlice.messages.some(
          (m) => m.kind === 'cli-stream-init',
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
        if (reduced.append === 'append' && message.kind === 'assistant') {
          store.clearInflightAssistant(tabIdRef.current);
          clearInflightBuffer(tabIdRef.current);
        }
        if (
          message.kind === 'system' &&
          (message as { subtype?: string }).subtype === 'notification' &&
          /error/i.test(String((message.raw as { notification_type?: string }).notification_type ?? ''))
        ) {
          store.clearInflightAssistant(tabIdRef.current);
          clearInflightBuffer(tabIdRef.current);
        }

        if (reduced.append === 'skip') return;
        // The reducer may hand back a rewritten node (e.g. a user-cancel
        // result kept as a benign turn-closer) — append that, not the raw one.
        const nodeToAppend = reduced.replaceWith ?? message;
        if (reduced.append === 'insertBeforeFirstUser') {
          ctx.insertMessageBeforeFirstUser(nodeToAppend);
          return;
        }
        ctx.appendMessage(nodeToAppend);
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
    // conversationStatus is now derived inside the hook from messages/tasks/subagents
    // via sessionDerivedState.conversationStatus (Task 2). The old FSM-driven approach
    // (reading the IPC payload's conversationStatus field) has been removed.
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
    agent,
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
    // Inputs for conversationStatus derivation. Messages are JsonlNode[] end-to-end; no adapter layer.
    messages,
    tasks: taskEntries,
    subagents,
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
  const isConversationInFlight =
    conversationStatus !== null && conversationStatus !== 'idle';
  const promptStatus: 'working' | 'ready' =
    isConversationInFlight ? 'working' : 'ready';
  const lastPromptStatusRef = useRef<'working' | 'ready' | null>(null);
  useEffect(() => {
    if (lastPromptStatusRef.current === promptStatus) return;
    lastPromptStatusRef.current = promptStatus;
    updateTab(tabIdRef.current, { promptStatus });
  }, [promptStatus, updateTab]);

  // Mirror the "waiting on the human" state onto the tab so the TabManager
  // can show a shield (permission) / question mark (AskUserQuestion). Same
  // pending permission that drives usePublishTabStatus and the in-session
  // permission card — one source of truth.
  const tabWaitingFor: TabWaitingFor = deriveWaitingFor(pendingPermission);
  const lastWaitingForRef = useRef<TabWaitingFor | undefined>(undefined);
  useEffect(() => {
    if (lastWaitingForRef.current === tabWaitingFor) return;
    lastWaitingForRef.current = tabWaitingFor;
    updateTab(tabIdRef.current, { waitingFor: tabWaitingFor });
  }, [tabWaitingFor, updateTab]);

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
  //      process — rebind to it so the in-flight CLI query keeps streaming
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

  // Parallel Codex notification accumulator. Subscribes to the same
  // `agent-output:` channel as the Claude path but only keeps payloads
  // shaped like Codex notifications (`{ method, params }`). For Claude
  // tabs this listener still runs but collects nothing (Claude payloads
  // carry `type` instead of `method`), so the cost is one empty array
  // per tab — negligible. Engaged only when `agent === 'codex'`; the
  // listener is torn down on agent change to keep the state honest.
  useEffect(() => {
    if (agent !== 'codex') {
      setCodexMessages([]);
      return;
    }
    const unlisten = window.electronAPI.onEvent(
      `agent-output:${tabIdRef.current}`,
      (...args: unknown[]) => {
        const payload = args[0];
        if (!payload || typeof payload !== 'object') return;
        const method = (payload as { method?: unknown }).method;
        if (typeof method !== 'string') return;
        const receivedAt =
          typeof (payload as { receivedAt?: unknown }).receivedAt === 'string'
            ? (payload as { receivedAt: string }).receivedAt
            : new Date().toISOString();
        const next: AgentMessage = {
          agent: 'codex',
          tabId: tabIdRef.current,
          receivedAt,
          sessionId: claudeSessionId,
          payload,
        };
        setCodexMessages((prev) => [...prev, next]);
      },
    );
    return () => { unlisten(); };
  }, [agent, claudeSessionId]);

  // Rate-limit snapshots for the active account: fetch initial state on
  // resolution, then live-update from the main process's
  // `rate-limits:updated` event whenever a CLI rate-limit event lands.
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
          // Mirror loadSessionHistory(): classify → normalize.
          const loaded: JsonlNode[] = history
            .map((entry: unknown) => classifyJsonlLine(entry))
            .filter((n): n is NonNullable<typeof n> => n !== null)
            .map((n) => normalizeJsonlNode(n));
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
          // CLI query waits for its first message.
          resetStatus({ sessionStatus: 'started', conversationStatus: 'idle' });
          // On return to CLI mode, reload history from the JSONL file.
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

  // Mirror model / permission-mode changes the user makes inside a live TUI
  // session. In TUI mode the terminal owns these — the popover pickers are
  // read-only there — so this keeps them in sync when the user switches model
  // (`/model`) or cycles permission mode (shift+tab) in the terminal. The
  // main process detects the change from the session JSONL and emits here.
  // Effort/thinking isn't covered (never reaches the JSONL).
  useEffect(() => {
    const unlisten = window.electronAPI.onEvent(
      `session-control-state:${tabIdRef.current}`,
      (...args: unknown[]) => {
        const payload = args[0] as { model?: string; permissionMode?: string } | undefined;
        // selectedModel may become a concrete CLI id (e.g. `claude-opus-4-8`);
        // SessionDefaultsRow's pickModelOption resolves it to the right
        // picker option for display.
        if (typeof payload?.model === 'string' && payload.model.length > 0) {
          setSelectedModel(payload.model);
        }
        if (typeof payload?.permissionMode === 'string' && payload.permissionMode.length > 0) {
          setPermissionMode(payload.permissionMode);
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
  // api.stopSession() which fully tore down the CLI session, killing the
  // Claude subprocess, losing conversation history, and forcing a restart
  // on the next prompt. Now we call api.sessionInterrupt() which halts the
  // current assistant turn but keeps the session alive so the user can
  // continue typing. If interrupt fails (old CLI, bad state, subprocess
  // crash), we fall back to the hard stop path to guarantee the UI unsticks.
  const handleCancelExecution = async () => {
    if (!isLoading) return;

    const tid = tabIdRef.current;

    try {
      // Flag so the stream listener suppresses the next CLI error-result
      // message (the CLI emits is_error after interrupt and we don't want
      // an "Execution Failed" card for a deliberate user cancel).
      userInterruptedRef.current = true;

      await api.sessionInterrupt(tid);

      // Session stays alive — don't clean up listeners, don't unset
      // persistentSessionRef. The CLI will emit a result message with
      // stop_reason "interrupted" which the normal message loop handles.
      setIsLoading(false);
      setError(null);
      setQueuedPrompts([]);

      const interruptMessage: JsonlNode = {
        kind: 'system',
        subtype: 'notification',
        raw: {
          type: 'system',
          subtype: 'notification',
          notification_type: 'stop',
          body: 'Response interrupted — session still active',
          timestamp: new Date().toISOString(),
          sessionId: '',
        } as never,
        sessionId: '',
        receivedAt: new Date().toISOString(),
      };
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

      const errorMessage: JsonlNode = {
        kind: 'system',
        subtype: 'notification',
        raw: {
          type: 'system',
          subtype: 'notification',
          notification_type: 'stop',
          body: 'Session cancelled by user',
          timestamp: new Date().toISOString(),
          sessionId: '',
        } as never,
        sessionId: '',
        receivedAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    }
  };

  // Clear the conversation: stop the current CLI session, reset all
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
    // spawning a new CLI process. Previously this code stopped the session
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

  const messagesList = agent === 'codex' ? (
    <CodexTranscript
      messages={codexMessages}
      tabId={tabIdRef.current}
    />
  ) : (
    <ClaudeTranscript
      messages={messages}
      viewMode={viewMode}
      accountType={accountResolution?.account.subscription_label}
      onResend={onResendStable}
      onLinkDetected={handleLinkDetected}
      waitingForPermission={waitingForPermission}
      outstandingWork={outstandingWork}
      hasInflightAssistant={hasInflightAssistant}
      currentActivity={currentActivity}
      totalTokens={totalTokens}
      error={error}
      tabId={tabIdRef.current}
      messagesEndRef={messagesEndRef}
      isNearBottomRef={isNearBottomRef}
    />
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
  // we're navigating away from. Auto-on-close only fires when the CLI
  // session is torn down (tab close); back-button keeps the CLI
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
  // 5→3 collapse: 'starting' | 'started' (session) + 'idle' | 'running'
  // (conversation) + null → 'starting' | 'active' | 'ended'. Renamed from
  // `sessionStatus` to avoid colliding with the hook's canonical name.
  const displayStatus: 'starting' | 'active' | 'ended' | undefined =
    !sessionStarted
      ? undefined
      : isSessionActive
        ? 'active'
        : isSessionStarting
          ? 'starting'
          : 'ended';

  // Proactively pull the live context window once a session is active but we
  // don't have it yet. Resuming a session loads history statically and never
  // fetches usage — the stream-driven refresh only fires on init/result/
  // compact_boundary — so an idle resumed chat-mode session would otherwise sit
  // on the client-side fallback (wrong denominator, no category breakdown)
  // until its next turn. The control request is now timeout-guarded (see
  // control-request-registry.ts), so this can't hang; on a null/timed-out reply
  // the gauge simply stays on the fallback. Re-runs only when the active flag
  // flips or `contextUsage` clears, so it can't loop.
  useEffect(() => {
    if (displayStatus !== 'active' || contextUsage != null) return;
    const tabId = tabIdRef.current;
    let cancelled = false;
    api.sessionContextUsage(tabId)
      .then((usage) => {
        if (!cancelled && usage) streamCtxRef.current.setContextUsage(usage);
      })
      .catch(() => { /* hang-safe; fallback gauge stays until the next turn */ });
    return () => { cancelled = true; };
  }, [displayStatus, contextUsage]);

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
          {/* The agent (Claude / Codex) is now rendered inside the
              AccountBadge as the trailing brand mark. Standalone
              AgentBadge removed; access to the account picker moves
              to the AccountCard's existing details popover (future work). */}
          {accountResolution && (
            <AccountCard
              accountName={accountResolution.account.name}
              hasCost={accountResolution.account.has_cost}
              agent={agent}
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
            defaultModel={accountDefaultModel}
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
            controls={
              <SessionDefaultsRow
                engine={agent}
                direction="column"
                // TUI mode owns these via the terminal; the pickers can't
                // drive the CLI (no control-protocol engine in TUI), so they
                // render read-only and mirror the auto-detected live state.
                disabled={sessionMode === 'tui'}
                configDir={accountResolution?.account.config_dir}
                model={selectedModel}
                setModel={(newModel) => {
                  // Updates selectedModel AND, if a session is running, pushes
                  // the switch to the CLI immediately via sessionSetModel() so
                  // the user doesn't have to wait until the next send.
                  setSelectedModel(newModel);
                  if (persistentSessionRef.current) {
                    const tid = tabIdRef.current;
                    api.sessionSetModel(tid, newModel).then(() => {
                      // Live transcript marker — model changes are out-of-band
                      // control requests that never reach the JSONL, so this
                      // live-only marker is the only scrollback record.
                      appendMessage({
                        kind: 'control-change',
                        control: 'model',
                        value: String(newModel),
                        sessionId: tid,
                        receivedAt: new Date().toISOString(),
                      });
                    }).catch((err: unknown) => {
                      console.error('[sessions] sessionSetModel failed:', err);
                    });
                  }
                }}
                effort={effort}
                setEffort={(level) => {
                  setEffort(level as EffortLevel);
                  if (persistentSessionRef.current) {
                    const tid = tabIdRef.current;
                    api.sessionSetEffort(tid, level as EffortLevel).then(() => {
                      // Drop a live transcript marker so the change is visible in
                      // scrollback. Effort never reaches the JSONL, so this is the
                      // only record — live-session only (not persisted).
                      appendMessage({
                        kind: 'control-change',
                        control: 'effort',
                        value: String(level),
                        sessionId: tid,
                        receivedAt: new Date().toISOString(),
                      });
                    }).catch((err: unknown) => {
                      console.error('[sessions] sessionSetEffort failed:', err);
                    });
                  }
                }}
                permissionMode={permissionMode}
                setPermissionMode={(mode) => {
                  // Update local state AND, if a session is running, push the
                  // change to the CLI via sessionSetPermissionMode(). Swallow
                  // errors so a bad mode doesn't revert the UI.
                  setPermissionMode(mode);
                  if (persistentSessionRef.current) {
                    const tid = tabIdRef.current;
                    api.sessionSetPermissionMode(tid, mode).then(() => {
                      // Live transcript marker. The CLI DOES persist a
                      // `permission-mode` JSONL line, but jsonl-tail only forwards
                      // closure-carriers (queue-operation/attachment) to the live
                      // stream — so the persisted line shows up only on resume,
                      // never live. This synthetic marker gives the immediate
                      // feedback; the persisted line covers scrollback after
                      // resume. They never coexist in one view, so no double.
                      appendMessage({
                        kind: 'control-change',
                        control: 'permission',
                        value: String(mode),
                        sessionId: tid,
                        receivedAt: new Date().toISOString(),
                      });
                    }).catch((err: unknown) => {
                      console.error('[sessions] sessionSetPermissionMode failed:', err);
                    });
                  }
                }}
              />
            }
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
              resolvePair={resolvePair}
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
              effort={effort}
              setEffort={setEffort}
              permissionMode={permissionMode}
              setPermissionMode={setPermissionMode}
              sessionStartMode={sessionStartMode}
              setSessionStartMode={setSessionStartMode}
              agent={agent}
              setAgent={setAgent}
              agentPickerDisabled={isSessionStarting}
              onStart={() => {
                // sessionStarted is derived from sessionStatus — startPersistentSession
                // sets it to 'starting' synchronously, which flips sessionStarted true.
                logAndForget('claude-code-session:start-persistent-session', startPersistentSession());
              }}
              onChangeAccount={() => { setShowAccountPicker(true); }}
              onChooseAccount={() => { setShowAccountPicker(true); }}
              codexAuthStatus={codexAuthStatus}
              onCodexSignIn={() => { setShowCodexSignIn(true); }}
            />
            <CodexSignInModal
              open={showCodexSignIn}
              configDir={accountResolution?.account.config_dir ?? ''}
              onClose={() => { setShowCodexSignIn(false); }}
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
                  subscription_label: account.subscription_label,
                  has_cost: account.has_cost,
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
                    <TuiSessionLayout tabId={tabIdRef.current} />
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
                <TuiSessionLayout tabId={tabIdRef.current} />
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
                            {modelDisplayName(queuedPrompt.model, supportedModels)}
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
              // The CLI gates the built-in `AskUserQuestion` tool through the
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
              // In TUI mode, route the prompt straight into the CLI's PTY —
              // identical to the user typing it into xterm and pressing
              // Enter. The rich-mode handleSendPrompt path uses the engine's
              // stream-json stdin, which the TUI subprocess isn't listening
              // on. See src/lib/tuiPromptHandler.ts.
              onSend={
                sessionMode === 'tui'
                  ? fireAndLog('claude-code-session:send-tui', createTuiPromptHandler(tabIdRef.current))
                  : fireAndLog('claude-code-session:send', handleSendPrompt)
              }
              onCancel={fireAndLog('claude-code-session:cancel', handleCancelExecution)}
              isLoading={isLoading}
              disabled={!projectPath}
              projectPath={projectPath}
              configDir={accountResolution?.account.config_dir}
              tabId={tabIdRef.current}
              defaultModel={selectedModel}
              supportedCommands={supportedCommands}
              modeToggle={
                <div className="flex items-center gap-1.5 w-full">
                  <HeaderLabel className="w-12 shrink-0">mode</HeaderLabel>
                  <SessionModeToggle
                    className="flex-1"
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
                <div className="flex items-center gap-1.5 w-full">
                  <HeaderLabel className="w-12 shrink-0">output</HeaderLabel>
                  <SessionViewToggle className="flex-1" mode={viewMode} onChange={setViewMode} />
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
