import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useSessionViewMode } from '@/hooks/useSessionViewMode';
import { motion, AnimatePresence } from "framer-motion";
import {
  Shield,
  Layers,
  MessageCircleQuestion,
} from "lucide-react";
import { SessionInspectorPanel } from "@/components/SessionInspectorPanel";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { api, type Session, type RateLimitSnapshot, type Account, type ResolvePair, type AccountMismatch, type SessionAccountInfo, type SessionContextUsage, type SessionModelInfo, type SessionSlashCommand } from "@/lib/api";
import { AttentionSlot } from "@/components/AttentionSlot";
import { SignalBadge } from "@/components/signals/SignalBadge";
import { SignalEventLog } from "@/components/signals/SignalEventLog";
import { useSessionGauges } from "@/contexts/SessionGaugesContext";
import { useSessionSignals } from "@/hooks/useSessionSignals";
import { POPOVER_EVENT_LIMIT } from "@/lib/signals/store";
import { resolveContextLimit } from "@/lib/contextLimit";
import { withoutWithdrawnPermission } from "@/lib/types/permissionRequest";
import { SessionActionsProvider, type SessionActions } from "@/contexts/SessionActionsContext";
import { selectContextTokens } from "@/lib/contextPressure";
import { observeCacheTtlMs, lastAssistantAnchorMs, lastCacheTtlChange } from "@/lib/cacheExpiry";
import { latestMcpServerErrors } from "@/lib/mcpServerErrors";
import { useAccountVerdict } from "@/hooks/useAccountVerdict";
import { resolveSessionVerification } from "@/lib/accountVerification";
import { cn } from "@/lib/utils";
import { NewSessionForm } from "./NewSessionForm";
import { AccountPickerDialog } from "./AccountPickerDialog";
import { CodexSignInModal } from "@/components/codex/CodexSignInModal";
import { useCodexAuthStatus } from "@/hooks/useCodexAuthStatus";
import { ClaudeTranscript } from "@/components/claude/ClaudeTranscript";
import { CodexTranscript } from "@/components/codex/CodexTranscript";
import type { AgentMessage } from "@/lib/api";
import { applyRateLimitUpdate, type RateLimitUpdate } from "@/lib/rateLimitSnapshots";
import {
  FloatingPromptInput,
  type FloatingPromptInputRef,
  type EffortLevel,
} from "./FloatingPromptInput";
import { modelPickerLabel, effectiveModels, liveDefaultEvidence } from '@/lib/modelCatalog';
import { sessionControlSummary } from "@/lib/sessionControlSummary";
import { SessionControlPickers } from "@/components/SessionControlPickers";
import { PERMISSION_MODES } from "@/components/ControlBar";
import { changeSessionPermissionMode } from "@/lib/sessionPermissionModeChange";
import { ErrorBoundary } from "./ErrorBoundary";
import { SlashCommandsManager } from "./SlashCommandsManager";
import { SessionMCPStatus } from "./SessionMCPStatus";
import { SessionContextPanel, SessionContextRefreshButton } from "./SessionContextPanel";
import { TranscriptSkeleton } from "./claude/TranscriptSkeleton";
import { ModernQuestionCard } from "./transcript-modern/ModernQuestion";
import { ModernPermissionCard } from "./transcript-modern/ModernPermissionCard";
import { ElicitationDialog, type ElicitationRequest } from "./ElicitationDialog";
import { SessionPermissionsEditor } from "./SessionPermissionsEditor";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { TooltipProvider, TooltipSimple } from "@/components/ui/tooltip-modern";
import type { JsonlNode } from "@/types/jsonl";
import { normalizeJsonlNode } from "@/lib/normalizeMessage";
import { classifyJsonlLine } from '@/lib/jsonlClassifier';
import { permissionCheckFrame } from '@/lib/permissionChecks';
import { lastPermissionMode, lastAssistantModel, lastSessionModel, usageLimitWait } from '@/lib/sessionDerivedState';
import { useSlashModelSync } from '@/hooks/useSlashModelSync';
import { useSessionAuthExpiry } from '@/hooks/useSessionAuthExpiry';
import { useRemoteResync } from "@/hooks/useRemoteResync";
import { firstPromptText } from '@/lib/sessionTitle';
import { CaughtUpPill } from "./RemoteConnectionBanner";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { useSwipeTabs } from "@/hooks/useSwipeTabs";
import { changeSessionModel } from '@/lib/sessionModelChange';
import { forwardedParentToolUseId } from '@/lib/subagentDispatch';
import { reduceSessionStreamMessage } from '@/lib/sessionStreamReducer';
import { isCliPromptRecord } from '@/lib/promptReconciliation';
import { isRepeatedRecord, withoutRepeatedRecords } from '@/lib/repeatedRecords';
import {
  POST_COMPACT_ENABLED_SETTING_KEY,
  POST_COMPACT_PROMPT_SETTING_KEY,
  resolvePostCompactDirective,
} from '@/lib/postCompactPrompt';
import type { ModelPricingInput } from '@/lib/pricing';
import { runStreamEffect, drainQueuedPrompt, withoutQueuedImage } from '@/lib/sessionStreamEffects';
import { QueuedPromptsPanel } from '@/components/QueuedPromptsPanel';
import { appendInflightDelta, appendInflightThinkingDelta, clearInflightThinking } from '@/lib/inflightCoalescer';
import { maybeAutoGenerateSummaryOnLeave } from "@/lib/sessionSummaryGate";
import { SessionViewToggle } from "./SessionViewToggle";
import { HeaderLabel } from "./HeaderLabel";
import { AccountCard } from "./AccountCard";
import { SessionCard } from "./SessionCard";
import { SessionStatusItem } from "@/components/SessionStatusItem";
import { AccountStatusItem } from "@/components/AccountStatusItem";
import { NewSessionButton } from "@/components/NewSessionButton";
import { BranchStatusBar } from "@/components/claude-code-session/BranchStatusBar";
import { useRepoBranchPins } from "@/hooks/useRepoBranchPins";
import { useRepoAliases } from "@/hooks/useRepoAliases";
import { ProjectReposDialog } from "@/components/ProjectReposDialog";
import { useAccountUsage } from "@/hooks/useAccountUsage";
import { ChatStatusBar } from "./ChatStatusBar";
import { SessionHeaderResizeHandle } from "./SessionHeaderResizeHandle";
import { SessionSidePanels, type SessionSidePanelKey } from "./SessionSidePanels";
import { SideChatPanel } from "./SideChatPanel";
import { useSideChat } from "@/hooks/useSideChat";
import { useGitWatchVisibility } from "@/hooks/useGitWatchVisibility";
import { GitDiffOverlay } from '@/components/git-diff/GitDiffOverlay';
import { ContextLedgerPanel } from "./ContextLedgerPanel";
import { useSessionPlugins } from "@/hooks/useSessionPlugins";
import { useSessionMcpStatus } from "@/hooks/useSessionMcpStatus";
import { latestInitMcpCount, modStatusLines, splitPlugins } from "@/lib/sessionLoadout";
import { foldContextLedger } from "@/lib/contextLedger";
import { useDaemonLink } from "@/hooks/useDaemonLink";
import { GitWatchStatusIcon } from "./claude-code-session/GitWatchStatusIcon";
import { deriveSubagents, applySubagentMeta, createSubagentColorAllocator, notificationStatsByToolUse, forwardedByAgentId, countActiveSubagents, type SubagentMetaInput } from '@/lib/subagentStreams';
import { getTaskList, summarizeTaskList } from "@/lib/taskList";
import { deriveWaitingFor, type TabWaitingFor } from "@/lib/tabWaitingFor";
import { deriveBackgroundShells } from "@/lib/backgroundShells";
import type { BackgroundWork } from "./BackgroundWorkItems";
import { TaskList } from "./claude/tools/TaskList";
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";
import { decideResumeSeed } from "@/lib/resumeSeedDecision";
import { decideAutoStart, decideRebindTarget, shouldShowNewSessionPanel } from "@/lib/sessionAutoStart";
import { usePermissions } from "@/hooks/usePermissions";
import { useSessionLifecycle } from "@/hooks/useSessionLifecycle";
import { useSendPrompt, type SendPromptOptions, type QueuedPromptItem } from "@/hooks/useSendPrompt";
import { usePublishTabStatus } from "@/hooks/usePublishTabStatus";
import { useRenderProfile } from "@/hooks/useRenderProfile";
import { useTabContext } from "@/contexts/TabContext";
import { SessionPersistenceService } from "@/services/sessionPersistence";
import { clearInflightBuffer } from "@/lib/inflightCoalescer";
import { useTabSession, useClaudeSessionStore, useTabSessionTitle } from "@/stores/claudeSessionStore";
import type { PermissionRequestPayload, PermissionSuggestion } from "@/lib/types/permissionRequest";

// Module scope keeps pickGerund's identity stable for effect deps.
interface SyntheticEnvelope {
  type?: unknown;
}

interface PermissionRequestWire {
  request_id: string;
  kind?: PermissionRequestPayload['kind'];
  tool_name: string;
  tool_input?: Record<string, unknown>;
  title?: string;
  display_name?: string;
  description?: string;
  decision_reason?: string;
  blocked_path?: string;
  directory_grant?: string[] | null;
  permission_suggestions?: PermissionSuggestion[];
  suppress_always_allow_rule?: unknown;
  agent?: PermissionRequestPayload['agent'];
  summary?: string;
  codex_payload?: unknown;
}

interface StreamEventWire {
  uuid: string;
  parent_tool_use_id: string | null;
  event?: {
    type?: string;
    delta?: { type?: string; text?: unknown; thinking?: unknown };
    content_block?: { type?: string };
  };
}

const GERUNDS = [
  "Honking", "Pondering", "Musing", "Cogitating", "Ruminating", "Brewing",
  "Noodling", "Puzzling", "Tinkering", "Scheming", "Conjuring", "Percolating",
  "Deliberating", "Contemplating", "Hatching", "Weaving", "Forging", "Crafting",
  "Kneading", "Sifting", "Plotting", "Wrangling",
] as const;
const pickGerund = (): string => GERUNDS[Math.floor(Math.random() * GERUNDS.length)];

const SHOW_HEADER_WIDGETS = false;

const HEADER_HEIGHT_KEY = 'omnifex.session-header-height';
const MIN_HEADER_HEIGHT = 60;
const MAX_HEADER_HEIGHT = 600;
// Must match header py-1.5 (12px) + card py-1 (8px).
const HEADER_VERTICAL_CHROME = 20;

interface AgentSessionProps {
  session?: Session;
  initialProjectPath?: string;
  tabId?: string;
  initialSessionConfig?: {
    model: string;
    effort: EffortLevel;
    permissionMode: string;
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
  // Send only after startPersistentSession() resolves; handleSendPrompt would otherwise spawn a second CLI process.
  initialPrompt?: string;
  // The owner must clear initialPrompt from the tab, or a restored tab re-sends it on every launch.
  onInitialPromptSent?: () => void;
  className?: string;
  onStreamingChange?: (isStreaming: boolean, sessionId: string | null) => void;
  onProjectPathChange?: (path: string) => void;
  // Gates auto-start so restored-but-inactive tabs don't rebind/resume on launch.
  isActive?: boolean;
}

export const AgentSession: React.FC<AgentSessionProps> = ({
  session,
  initialProjectPath = "",
  tabId,
  initialSessionConfig,
  initialPrompt,
  onInitialPromptSent,
  className,
  onStreamingChange,
  onProjectPathChange,
  isActive = true,
}) => {
  useRenderProfile('AgentSession');
  const [projectPath] = useState(initialProjectPath || session?.project_path || "");
  const sessionTabId = tabId || 'default';
  const {
    messages,
    setMessages,
    appendMessage,
    insertMessageBeforeFirstUser,
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

  // useTabSession setters are fresh every render; reading them through this ref keeps handleJsonlLine and loadSessionHistory stable (recreated callbacks dropped events and re-drained queued prompts).
  interface StreamCtx {
    appendMessage: typeof appendMessage;
    insertMessageBeforeFirstUser: typeof insertMessageBeforeFirstUser;
    handleSendPrompt:
      | ((prompt: string, model: string, images?: string[]) => Promise<unknown> | void)
      | null;
    setClaudeSessionId: typeof setClaudeSessionId;
    setContextUsage: typeof setContextUsage;
    setExtractedSessionInfo: typeof setExtractedSessionInfo;
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
    setSdkAccountInfo,
    setSupportedModels,
    setMessages,
    isMountedRef: null,
    queuedPromptsRef: null,
    setQueuedPrompts: null,
  });
  streamCtxRef.current.appendMessage = appendMessage;
  streamCtxRef.current.insertMessageBeforeFirstUser = insertMessageBeforeFirstUser;
  streamCtxRef.current.setClaudeSessionId = setClaudeSessionId;
  streamCtxRef.current.setContextUsage = setContextUsage;
  streamCtxRef.current.setExtractedSessionInfo = setExtractedSessionInfo;
  streamCtxRef.current.setSdkAccountInfo = setSdkAccountInfo;
  streamCtxRef.current.setSupportedModels = setSupportedModels;
  streamCtxRef.current.setMessages = setMessages;

  const [currentActivity, setCurrentActivity] = useState<string>("Honking");
  const [error, setError] = useState<string | null>(null);
  const [codexMessages, setCodexMessages] = useState<AgentMessage[]>([]);
  const [totalTokens, setTotalTokens] = useState(0);
  // The only signal that an "Account Default" session is 1M: its own model string never carries [1m].
  const [accountDefaultModel, setAccountDefaultModel] = useState<string | null>(null);
  const [supportedCommands, setSupportedCommands] = useState<import('@/lib/api').SessionSlashCommand[]>([]);
  const [diffTarget, setDiffTarget] = useState<{ path: string; label?: string } | null>(null);

  const [showSlashCommandsSettings, setShowSlashCommandsSettings] = useState(false);
  const [accountResolution, setAccountResolution] = useState<{
    account: { name: string; subscription_label: string; has_cost: boolean; config_dir: string; session_defaults?: import('@/lib/api').SessionDefaults };
    match_type: string;
    match_detail: string;
  } | null>(initialSessionConfig?.accountResolution ?? null);
  // A ref, not a dep: depending on accountResolution re-triggers the history reload when it resolves.
  const accountResolutionRef = useRef(accountResolution);
  accountResolutionRef.current = accountResolution;
  const [showAccountPicker, setShowAccountPicker] = useState(false);
  const [showCodexSignIn, setShowCodexSignIn] = useState(false);

  const [rateLimitSnapshots, setRateLimitSnapshots] = useState<
    Record<string, RateLimitSnapshot>
  >({});
  const [, setSessionCost] = useState(0);
  const [selectedModel, setSelectedModel] = useState<string>(initialSessionConfig?.model ?? "opus");
  const [permissionMode, setPermissionMode] = useState<string>(initialSessionConfig?.permissionMode ?? "acceptEdits");
  // Outranks every guess: a history load that lands later must not overwrite it.
  const livePermissionModeRef = useRef<string | null>(null);
  const [effort, setEffort] = useState<EffortLevel>(initialSessionConfig?.effort ?? 'high');
  const tabContextForAgent = useTabContext();
  const initialAgentFromTab: import('@/lib/api').AgentKind =
    tabContextForAgent.getTabById(tabId || 'default')?.agent ?? 'claude';
  const [agent, setAgentLocal] = useState<import('@/lib/api').AgentKind>(initialAgentFromTab);
  const setAgent = useCallback((next: import('@/lib/api').AgentKind) => {
    setAgentLocal(next);
    tabContextForAgent.updateTab(tabId || 'default', { agent: next });
  }, [tabContextForAgent, tabId]);
  const codexAuthStatus = useCodexAuthStatus(
    agent === 'codex' ? (accountResolution?.account.config_dir ?? null) : null,
  );
  const {
    verdict: identityVerdict,
    loaded: identityLoaded,
    error: identityError,
    recheck: recheckIdentity,
  } = useAccountVerdict(accountResolution?.account.config_dir ?? null);

  const sessionVerification = useMemo(
    () =>
      resolveSessionVerification({
        verdict: identityVerdict,
        sessionEmail: sdkAccountInfo?.email ?? null,
        loaded: identityLoaded,
        error: identityError,
      }),
    [identityVerdict, identityLoaded, identityError, sdkAccountInfo?.email],
  );

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
      expected_email: null,
      created_at: '',
      updated_at: '',
    };
    const slot = {
      account,
      matchType:
        accountResolution.match_type === 'override' ? 'override' as const
        : accountResolution.match_type === 'on_disk' ? 'on_disk' as const
        : 'path_rule' as const,
      matchDetail: accountResolution.match_detail,
    };
    return agent === 'codex' ? { claude: null, codex: slot } : { claude: slot, codex: null };
  }, [accountResolution, agent]);
  const [sessionGit, setSessionGit] = useState<import('@/lib/api').SessionGitSnapshot | null>(null);
  const [gitWatchId, setGitWatchId] = useState<string | null>(null);
  const [reposDialogOpen, setReposDialogOpen] = useState(false);

  // State, not :hover: the pointer leaves the handle as soon as it is captured.
  const [headerResizing, setHeaderResizing] = useState(false);
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
  // Measured live: the badge wraps on long branch names, so a constant floor is wrong.
  const branchColRef = useRef<HTMLDivElement>(null);
  const backColRef = useRef<HTMLDivElement>(null);
  const [headerMinHeight, setHeaderMinHeight] = useState(MIN_HEADER_HEIGHT);
  const hasBranchCard = sessionGit !== null;
  useEffect(() => {
    const els = [branchColRef.current, backColRef.current].filter(
      (el): el is HTMLDivElement => el !== null,
    );
    if (els.length === 0) {
      setHeaderMinHeight(MIN_HEADER_HEIGHT);
      return;
    }
    const update = () => {
      setHeaderMinHeight(
        Math.max(
          MIN_HEADER_HEIGHT,
          ...els.map((el) => Math.ceil(el.getBoundingClientRect().height) + HEADER_VERTICAL_CHROME),
        ),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    for (const el of els) observer.observe(el);
    return () => { observer.disconnect(); };
  }, [hasBranchCard]);
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
    setHeaderResizing(true);
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(
        headerMinHeight,
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
      // Also on pointercancel, or a cancelled drag strands the border lit.
      setHeaderResizing(false);
    };
    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', onUp);
    handleEl.addEventListener('pointercancel', onUp);
  }, [headerHeight, headerMinHeight]);
  const handleHeaderResizeReset = useCallback(() => {
    setHeaderHeight(null);
    window.localStorage.removeItem(HEADER_HEIGHT_KEY);
  }, []);

  // Skip on an explicit account override: re-resolving via rules would clobber the user's choice.
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

  // getClaudeDefaultModel, not getClaudeSettings().model: ANTHROPIC_DEFAULT_MODEL outranks the settings.json pin.
  const accountConfigDir = accountResolution?.account.config_dir ?? null;
  useEffect(() => {
    if (!accountConfigDir) { setAccountDefaultModel(null); return; }
    let cancelled = false;
    api.getClaudeDefaultModel({ configDir: accountConfigDir })
      .then(({ model }) => {
        if (cancelled) return;
        setAccountDefaultModel(model);
      })
      .catch(() => { if (!cancelled) setAccountDefaultModel(null); });
    return () => { cancelled = true; };
  }, [accountConfigDir]);

  const liveDefaultModel = useMemo(
    () => contextUsage?.model || lastAssistantModel(messages),
    [contextUsage, messages],
  );

  // A typed /model switches the CLI, not selectedModel; follow the CLI's answer.
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0);
  const bumpCatalogRefresh = useCallback(() => { setCatalogRefreshKey((k) => k + 1); }, []);
  useSlashModelSync({ messages, onModel: setSelectedModel, onSavedAsDefault: bumpCatalogRefresh });

  const accountDefaultsApplied = useRef(false);
  useEffect(() => {
    if (!accountResolution || accountDefaultsApplied.current) return;
    if (!!session || !!initialSessionConfig) return;
    const defaults = accountResolution.account.session_defaults;
    if (!defaults) return;
    accountDefaultsApplied.current = true;
    if (defaults.model) setSelectedModel(defaults.model);
    if (defaults.permissionMode) setPermissionMode(defaults.permissionMode);
    if (defaults.effort) setEffort(defaults.effort);
  }, [accountResolution, session, initialSessionConfig]);

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

  useGitWatchVisibility(gitWatchId, isActive);

  const gitRepos = useMemo(() => sessionGit?.repos ?? [], [sessionGit?.repos]);
  const gitStatus = gitRepos.find((r) => r.name === '')?.root ?? null;
  const branchPins = useRepoBranchPins(gitRepos.map((r) => r.root.path));
  const repoAliases = useRepoAliases(gitRepos.map((r) => r.root.path));
  // The diff overlay is pull-only; this bump is its only refresh signal.
  const diffReading = diffTarget
    ? gitRepos.flatMap((r) => [r.root, ...r.worktrees]).find((p) => p.path === diffTarget.path) ?? null
    : null;
  const gitRefreshToken = (diffReading?.changed ?? 0) * 1000 + (diffReading?.untracked ?? 0);
  const gitWatchErrors = useMemo(() => {
    const out: { label: string; error: string }[] = [];
    for (const repo of gitRepos) {
      const prefix = repo.name ? `${repo.name}·` : '';
      if (repo.root.error) out.push({ label: `${prefix}${repo.root.branch ?? 'project'}`, error: repo.root.error });
      for (const wt of repo.worktrees) {
        if (wt.error) out.push({ label: `${prefix}${wt.branch ?? wt.path}`, error: wt.error });
      }
    }
    return out;
  }, [gitRepos]);

  const {
    pendingPermission,
    setPendingPermission,
    waitingForPermission,
    handlePermissionAllow,
    handlePermissionDeny,
    handlePermissionAllowWithInput,
  } = usePermissions();

  const [elicitationRequest, setElicitationRequest] = useState<ElicitationRequest | null>(null);

  const persistentSessionRef = useRef(false);
  // Read at call time: a captured handleSendPrompt otherwise sees a stale turn and drained prompts silently re-queue.
  const turnRunningRef = useRef(false);
  const editingPromptIdRef = useRef<string | null>(null);
  // The drain reads the ref; the state only drives the panel.
  const [queueHeld, setQueueHeldState] = useState(false);
  const queueHeldRef = useRef(false);
  const setQueueHeld = useCallback((held: boolean) => {
    queueHeldRef.current = held;
    setQueueHeldState(held);
  }, []);
  const [accountMismatch, setAccountMismatch] = useState<AccountMismatch | null>(null);
  const [restartingSession, setRestartingSession] = useState(false);
  const INSPECTOR_PREF_KEY = 'omnifex_session_inspector_open';
  const [sidePanel, setSidePanel] = useState<SessionSidePanelKey | null>(() => {
    try { return localStorage.getItem(INSPECTOR_PREF_KEY) === '1' ? 'inspector' : null; } catch { return null; }
  });
  const inspectorOpen = sidePanel === 'inspector';
  useEffect(() => {
    try { localStorage.setItem(INSPECTOR_PREF_KEY, inspectorOpen ? '1' : '0'); } catch { /* private mode etc. */ }
  }, [inspectorOpen]);
  const toggleSidePanel = (key: SessionSidePanelKey) => {
    setSidePanel((prev) => (prev === key ? null : key));
  };
  // Stable: ClaudeTranscript is memoised; a fresh closure re-renders the whole transcript.
  const openInspector = useCallback(() => { setSidePanel('inspector'); }, []);
  const sideChat = useSideChat(tabId || 'default');
  const [sideChatOpen, setSideChatOpen] = useState(false);
  const [sideChatFocus, setSideChatFocus] = useState(0);
  const sideChatVisible = agent !== 'codex' && (sideChatOpen || sideChat.sideChat.exchanges.length > 0);
  const openSideChat = useCallback(() => {
    setSideChatOpen(true);
    setSideChatFocus((n) => n + 1);
  }, []);
  const { close: closeSideChatThread, ask: askSideChat } = sideChat;
  const routeToSideChat = useCallback((question: string) => {
    openSideChat();
    if (question) void askSideChat(question);
  }, [openSideChat, askSideChat]);
  const closeSideChat = useCallback(() => {
    closeSideChatThread();
    setSideChatOpen(false);
  }, [closeSideChatThread]);
  const tabIdRef = useRef(tabId || 'default');
  // Clear the store slot too: a RAF pending at teardown would leave a stale slot.
  useEffect(() => () => {
    const tabId = tabIdRef.current;
    clearInflightBuffer(tabId);
    clearInflightThinking(tabId);
    useClaudeSessionStore.getState().clearInflightAssistant(tabId);
  }, []);
  const floatingPromptRef = useRef<FloatingPromptInputRef>(null);
  const userInterruptedRef = useRef(false);
  const isNearBottomRef = useRef(true);

  // Refs so the stream handler never re-subscribes; seeded with the shipped default so an early compaction still gets the directive.
  const postCompactPromptRef = useRef<string>(resolvePostCompactDirective(null, null));
  const selectedModelRef = useRef<string>(selectedModel);
  useEffect(() => { selectedModelRef.current = selectedModel; }, [selectedModel]);
  useEffect(() => {
    let cancelled = false;
    // A failed read keeps the shipped default; it must not disable the directive.
    Promise.all([
      api.getSetting(POST_COMPACT_ENABLED_SETTING_KEY),
      api.getSetting(POST_COMPACT_PROMPT_SETTING_KEY),
    ])
      .then(([enabled, stored]) => {
        if (!cancelled) postCompactPromptRef.current = resolvePostCompactDirective(enabled, stored);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  
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

  // Refs, never state: read per message inside the reducer ctx and must not trigger renders or effects.
  const costSeenKeysRef = useRef<Set<string>>(new Set());
  const pricingOverridesRef = useRef<readonly ModelPricingInput[] | undefined>(undefined);

  // Empty deps + ref-only writes: must never become a render loop like the TabContent inline-closure bug.
  useEffect(() => {
    void api
      .modelPricingList()
      .then((rows) => {
        pricingOverridesRef.current = rows.length > 0 ? rows : undefined;
      })
      .catch(() => {});
  }, []);

  // Keyed on projectPath only: TabContent passes a fresh closure and updateTab allocates new tabs, so depending on the callback loops forever.
  const onProjectPathChangeRef = useRef(onProjectPathChange);
  onProjectPathChangeRef.current = onProjectPathChange;
  useEffect(() => {
    if (onProjectPathChangeRef.current && projectPath) {
      onProjectPathChangeRef.current(projectPath);
    }
  }, [projectPath]);

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

  const colorAllocatorRef = useRef(createSubagentColorAllocator());
  const [dismissedSubagents, setDismissedSubagents] = useState<Set<string>>(new Set());
  const baseSubagents = useMemo(() => {
    const all = deriveSubagents(messages, colorAllocatorRef.current);
    return dismissedSubagents.size === 0
      ? all
      : all.filter((s) => !dismissedSubagents.has(s.toolUseId));
  }, [messages, dismissedSubagents]);
  const [subagentMeta, setSubagentMeta] = useState<Record<string, SubagentMetaInput>>({});
  const subagentMetaRef = useRef(subagentMeta);
  subagentMetaRef.current = subagentMeta;
  const notificationStats = useMemo(() => notificationStatsByToolUse(messages), [messages]);
  const forwardedLive = useMemo(() => forwardedByAgentId(messages), [messages]);
  const subagents = useMemo(
    () => applySubagentMeta(baseSubagents, subagentMeta, notificationStats, forwardedLive),
    [baseSubagents, subagentMeta, notificationStats, forwardedLive],
  );
  // Must not depend on subagentMeta (the fetch sets it), or it loops.
  const completedSubagentIds = useMemo(
    () => baseSubagents.filter((s) => s.status !== 'running').map((s) => s.toolUseId),
    [baseSubagents],
  );
  const completedSubagentSig = completedSubagentIds.join(',');
  useEffect(() => {
    if (!claudeSessionId || !accountConfigDir || !projectPath) return;
    if (completedSubagentIds.length === 0) return;
    const needsFetch = completedSubagentIds.some(
      (id) => !subagentMetaRef.current[id]?.model,
    );
    if (!needsFetch) return;
    let cancelled = false;
    api
      .getSubagentMeta(accountConfigDir, projectPath, claudeSessionId)
      .then((map) => {
        if (cancelled || !map || Object.keys(map).length === 0) return;
        setSubagentMeta((prev) => ({ ...prev, ...map }));
      })
      .catch(() => { });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedSubagentSig, claudeSessionId, accountConfigDir, projectPath]);
  // The bubble follows the turn and tasksInFlight, never hasRunningSubagent: that faked a live turn whenever subagent tracking missed a closure.
  const hasInflightAssistant = useClaudeSessionStore(
    (s) => s.tabs[tabIdRef.current]?.inflightAssistant != null,
  );
  const checkingPermissions = useClaudeSessionStore(
    (s) => s.tabs[tabIdRef.current]?.permissionChecks.size ?? 0,
  );
  const taskEntries = useMemo(() => getTaskList(messages) ?? [], [messages]);
  // in_progress only: counting pending tasks spins forever on a resumed session with unstarted todos. Matches hasOpenTasks.
  const tasksInFlight = useMemo(
    () => summarizeTaskList(taskEntries).inProgress > 0,
    [taskEntries],
  );
  const [dismissedShells, setDismissedShells] = useState<Set<string>>(new Set());
  const shells = useMemo(() => {
    const all = deriveBackgroundShells(messages);
    return dismissedShells.size === 0 ? all : all.filter((sh) => !dismissedShells.has(sh.taskId));
  }, [messages, dismissedShells]);
  const dismissShell = useCallback((taskId: string) => {
    setDismissedShells((prev) => new Set(prev).add(taskId));
  }, []);
  const readShellOutput = useCallback(
    (taskId: string) => api.sessionTaskOutput(tabIdRef.current, taskId),
    [],
  );
  // Ask only: rows change state solely on the CLI's own task events.
  const stopTask = useCallback(
    (taskId: string) => api.sessionStopTask(tabIdRef.current, taskId),
    [],
  );
  const backgroundTask = useCallback(
    (toolUseId: string) => api.sessionBackgroundTask(tabIdRef.current, toolUseId),
    [],
  );
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
  const dismissAllEndedShells = useCallback(() => {
    setDismissedShells((prev) => {
      const next = new Set(prev);
      for (const sh of shells) {
        if (sh.status !== 'running') next.add(sh.taskId);
      }
      return next;
    });
  }, [shells]);
  // Memoised so a transcript tick that changes neither list doesn't hand the bar a new object.
  const backgroundWork = useMemo<BackgroundWork>(() => ({
    subagents,
    onDismissSubagent: dismissSubagent,
    onDismissAllCompletedSubagents: dismissAllCompletedSubagents,
    shells,
    readShellOutput,
    onDismissShell: dismissShell,
    onDismissAllEndedShells: dismissAllEndedShells,
    stopTask,
    backgroundTask,
  }), [subagents, dismissSubagent, dismissAllCompletedSubagents, shells, readShellOutput, dismissShell, dismissAllEndedShells, stopTask, backgroundTask]);

  const { getTabById, updateTab } = useTabContext();
  const tabTitle = getTabById(tabIdRef.current)?.title ?? projectPath ?? tabIdRef.current;

  const activeSubagentCount = countActiveSubagents(subagents);
  const taskListSummary = useMemo(() => {
    return taskEntries.length > 0
      ? summarizeTaskList(taskEntries)
      : { total: 0, done: 0, inProgress: 0, pending: 0, running: false };
  }, [taskEntries]);

  const [viewMode, setViewMode] = useSessionViewMode();

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Via ref, not deps: the parent may not memoize onStreamingChange, and depending on it loops.
  const onStreamingChangeRef = useRef(onStreamingChange);
  onStreamingChangeRef.current = onStreamingChange;

  // Last assistant turn only: summing every turn is cumulative tokens, not context.
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

  const {
    contextPressure: contextPressureSetting,
    setContextPressure,
    cacheTimerEnabled,
    contextJump: contextJumpSetting,
  } = useSessionGauges();

  const { tokens: gaugeTokens, sdkMaxTokens } = useMemo(
    () => selectContextTokens({ contextUsage, fallbackTokens: totalTokens }),
    [contextUsage, totalTokens],
  );
  const contextLimit = useMemo(
    () => resolveContextLimit({
      sdkMaxTokens,
      model: selectedModel,
      defaultModel: accountDefaultModel,
      runningModel: liveDefaultModel,
      catalog: supportedModels,
      pricingOverrides: pricingOverridesRef.current,
    }),
    [sdkMaxTokens, selectedModel, accountDefaultModel, liveDefaultModel, supportedModels],
  );

  // No clock here: ticking at this level would re-render the whole session tree every second.
  const daemonLink = useDaemonLink(sessionTabId, claudeSessionId ?? null);

  const cacheTtlMs = useMemo(
    () => (cacheTimerEnabled ? observeCacheTtlMs(messages) : null),
    [messages, cacheTimerEnabled],
  );
  const cacheAnchorMs = useMemo(
    () => (cacheTimerEnabled ? lastAssistantAnchorMs(messages) : null),
    [messages, cacheTimerEnabled],
  );

  // Not mirrored into local state on rename: the CLI's custom-title record is the single source.
  const sessionTitle = useTabSessionTitle(sessionTabId);

  const handleRenameSession = useCallback(async (title: string): Promise<boolean> => {
    try {
      return await api.sessionSetTitle(tabIdRef.current, title);
    } catch (err) {
      console.error('[sessions] sessionSetTitle failed:', err);
      return false;
    }
  }, []);
  // User-triggered only: a model call must not fire unasked.
  const firstPrompt = useMemo(() => firstPromptText(messages), [messages]);
  const handleSuggestTitle = useMemo(
    () => (firstPrompt
      ? async (): Promise<string | null> => {
          try {
            return await api.sessionSuggestTitle(tabIdRef.current, firstPrompt);
          } catch (err) {
            console.error('[sessions] sessionSuggestTitle failed:', err);
            return null;
          }
        }
      : undefined),
    [firstPrompt],
  );

  const cacheTtlChange = useMemo(
    () => (cacheTimerEnabled ? lastCacheTtlChange(messages) : null),
    [messages, cacheTimerEnabled],
  );
  const mcpServerErrors = useMemo(() => latestMcpServerErrors(messages), [messages]);

  // Memoised: runs once per record, never per row.
  const contextLedger = useMemo(() => foldContextLedger(messages), [messages]);
  const initMcpCount = useMemo(() => latestInitMcpCount(messages), [messages]);
  const modStatus = useMemo(() => modStatusLines(messages), [messages]);
  const contextPanelOpen = sidePanel === 'context';
  const sessionPlugins = useSessionPlugins(
    tabId || 'default',
    `${initMcpCount !== null}:${contextPanelOpen}`,
    initMcpCount !== null || contextPanelOpen,
  );
  const loadout = useMemo(() => {
    const split = sessionPlugins.plugins ? splitPlugins(sessionPlugins.plugins) : null;
    return { mods: split?.mods.length ?? null, plugins: split?.plugins.length ?? null, mcp: initMcpCount };
  }, [sessionPlugins.plugins, initMcpCount]);
  const openContextPanel = useCallback(() => { setSidePanel('context'); }, []);
  const [transcriptJump, setTranscriptJump] = useState<{ uuid: string; nonce: number } | null>(null);
  const jumpToMessage = useCallback((uuid: string) => {
    setTranscriptJump((prev) => ({ uuid, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const sessionMcp = useSessionMcpStatus(tabIdRef.current, contextPanelOpen);
  const refreshSessionPlugins = sessionPlugins.refresh;
  const refreshSessionMcp = sessionMcp.refresh;
  const refreshSessionContext = useCallback(() => {
    refreshSessionPlugins();
    refreshSessionMcp();
  }, [refreshSessionPlugins, refreshSessionMcp]);

  // conversationStatus stays 'running' while parked: the CLI still owns the turn.
  const usageLimitResetsAt = useMemo(() => usageLimitWait(messages), [messages]);

  // Last-value guard: updateTab returns a new tab every call, so an unguarded write loops.
  const lastCacheMirrorRef = useRef<string>('');
  useEffect(() => {
    const key = `${cacheAnchorMs ?? ''}:${cacheTtlMs ?? ''}`;
    if (lastCacheMirrorRef.current === key) return;
    lastCacheMirrorRef.current = key;
    updateTab(tabIdRef.current, { cacheAnchorMs, cacheTtlMs });
  }, [cacheAnchorMs, cacheTtlMs, updateTab]);

  // Via streamCtxRef: useTabSession setters recreate per render, which would refetch history every frame.
  const [historyLoading, setHistoryLoading] = useState(false);
  const loadSessionHistory = useCallback(async (
    target?: { id: string; project_id: string; project_path: string },
  ) => {
    const source = target ?? session;
    if (!source) return;

    try {
      setHistoryLoading(true);
      setError(null);

      const history = await api.loadSessionHistory(source.id, source.project_id, source.project_path);

      if (history && history.length > 0) {
        SessionPersistenceService.saveSession(
          source.id,
          source.project_id,
          source.project_path,
          history.length
        );
      }

      const nodes: JsonlNode[] = history
        .map((entry) => classifyJsonlLine(entry))
        .filter((n): n is NonNullable<typeof n> => n !== null)
        .map((n) => normalizeJsonlNode(n));

      // The CLI can re-append a compacted segment; one row per uuid.
      streamCtxRef.current.setMessages(withoutRepeatedRecords(nodes));

      const resumedMode =
        livePermissionModeRef.current
        ?? lastPermissionMode(nodes)
        ?? accountResolutionRef.current?.account.session_defaults?.permissionMode;
      if (resumedMode) setPermissionMode(resumedMode);

      // Restore the model too, or a relaunch spawns with the mount seed.
      const resumedModel = lastSessionModel(nodes);
      if (resumedModel) setSelectedModel(resumedModel);

      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      }, 100);
    } catch (err) {
      console.error("Failed to load session history:", err);
      setError("Failed to load session history");
    } finally {
      setHistoryLoading(false);
    }
  }, [session]);

  // Follow prop changes (open paths reassign sessionData without resetting the store, pinning the cost pill to the previous session) but never stomp the stream's fork-on-resume id; prevSessionIdRef starts undefined so a remount keeps the live id.
  const prevSessionIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const decision = decideResumeSeed({
      sessionId: session?.id ?? null,
      claudeSessionId,
      prevSessionId: prevSessionIdRef.current,
    });
    prevSessionIdRef.current = session?.id ?? null;
    if (decision === 'reseed' && session) {
      streamCtxRef.current.setClaudeSessionId(session.id);
      logAndForget('claude-code-session:load-session-history', loadSessionHistory());
    }
  }, [session, loadSessionHistory, claudeSessionId]);

  useRemoteResync(sessionTabId, () => {
    const id = claudeSessionId ?? session?.id;
    if (!id || !projectPath) return;
    logAndForget('claude-code-session:remote-resync', loadSessionHistory({
      id,
      project_id: projectPath.replace(/[^a-zA-Z0-9]/g, '-'),
      project_path: projectPath,
    }));
  });

  const loggedUnmountedDropRef = useRef(false);

  const handleJsonlLine = useCallback((payload: string | object) => {
    try {
      // Never drop silently: a stale listener discards a whole live turn without a trace.
      if (!streamCtxRef.current.isMountedRef?.current) {
        if (!loggedUnmountedDropRef.current) {
          loggedUnmountedDropRef.current = true;
          console.warn(
            `[AgentSession] dropping stream events for tab ${tabIdRef.current}: listener outlived its component`,
          );
        }
        return;
      }
      const raw: unknown = typeof payload === 'string' ? JSON.parse(payload) : payload;

      const envelope = raw && typeof raw === 'object' ? (raw as SyntheticEnvelope) : null;
      if (envelope?.type === 'permission_request') {
        const msg = envelope as PermissionRequestWire;
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
          directoryGrant: Array.isArray(msg.directory_grant) ? msg.directory_grant : undefined,
          suggestions: msg.permission_suggestions ?? [],
          suppressAlwaysAllowRule: msg.suppress_always_allow_rule === true,
          agent: msg.agent,
          summary: msg.summary,
          payload: msg.codex_payload,
        });
        return;
      }

      if (envelope?.type === 'permission_withdrawn') {
        const requestId = String((envelope as { request_id?: string }).request_id ?? '');
        setPendingPermission((current) => withoutWithdrawnPermission(current, requestId));
        return;
      }

      if (envelope?.type === 'stream_event') {
        const m = envelope as StreamEventWire;
        if (m.parent_tool_use_id != null) return;
        const event = m.event;
        if (
          event?.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          typeof event.delta.text === 'string'
        ) {
          appendInflightDelta(tabIdRef.current, m.uuid, event.delta.text, m.parent_tool_use_id);
        }
        if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
          clearInflightThinking(tabIdRef.current);
        }
        if (
          event?.type === 'content_block_delta' &&
          event.delta?.type === 'thinking_delta' &&
          typeof event.delta.thinking === 'string' &&
          event.delta.thinking !== ''
        ) {
          appendInflightThinkingDelta(tabIdRef.current, event.delta.thinking);
        }
        return;
      }

      const node = classifyJsonlLine(raw);
      if (!node) return;
      if (node.kind === 'tool-progress') {
        useClaudeSessionStore.getState().applyToolProgress(sessionTabId, node);
        return;
      }
      if (node.kind === 'stream-event' || node.kind === 'rate-limit' || node.kind === 'lifecycle') return;
      if (isRepeatedRecord(useClaudeSessionStore.getState().selectTab(sessionTabId).messages, node)) return;
      const permissionCheck = permissionCheckFrame(node);
      if (permissionCheck) {
        useClaudeSessionStore.getState().applyPermissionCheck(sessionTabId, permissionCheck);
      }
      const normalizedNode = normalizeJsonlNode(node);

      const ctx = streamCtxRef.current;

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
          pricingOverrides: pricingOverridesRef.current,
          seenCostKeys: costSeenKeysRef.current,
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
            setSdkAccountInfo: (info) => { ctx.setSdkAccountInfo(info as SessionAccountInfo | null); },
            setContextUsage: (usage) => { ctx.setContextUsage(usage as SessionContextUsage | null); },
            setSupportedModels: (models) => { ctx.setSupportedModels(models as SessionModelInfo[]); },
            setSupportedCommands: (commands) => { setSupportedCommands(commands as SessionSlashCommand[]); },
            queuedPromptsRef: ctx.queuedPromptsRef as { current: QueuedPromptItem[] },
            setQueuedPrompts: ctx.setQueuedPrompts as (next: QueuedPromptItem[]) => void,
            turnRunningRef,
            editingPromptIdRef,
            queueHeldRef,
            handleSendPrompt: fireAndLog(
              'claude-code-session:send-prompt-effect',
              handleSendPromptForEffect ?? undefined,
            ),
            postCompactPrompt: postCompactPromptRef.current,
            currentModel: selectedModelRef.current,
            onError: (kind, err) =>
              { console.error(`[sessions] effect ${kind} failed:`, err); },
          });
        }

        const store = useClaudeSessionStore.getState();
        // Forwarded subagent assistants must not clear the parent's streaming bubble.
        if (
          reduced.append === 'append' &&
          message.kind === 'assistant' &&
          forwardedParentToolUseId(message.raw) === null
        ) {
          store.clearInflightAssistant(tabIdRef.current);
          clearInflightBuffer(tabIdRef.current);
          clearInflightThinking(tabIdRef.current);
        }
        if (
          message.kind === 'system' &&
          (message as { subtype?: string }).subtype === 'notification' &&
          /error/i.test(String((message.raw as { notification_type?: string }).notification_type ?? ''))
        ) {
          store.clearInflightAssistant(tabIdRef.current);
          clearInflightBuffer(tabIdRef.current);
          clearInflightThinking(tabIdRef.current);
        }

        if (reduced.append === 'skip') return;
        // Append the reducer's rewritten node, not the raw one.
        const nodeToAppend = reduced.replaceWith ?? message;
        if (reduced.append === 'insertBeforeFirstUser') {
          ctx.insertMessageBeforeFirstUser(nodeToAppend);
          return;
        }
        if (isCliPromptRecord(nodeToAppend)) {
          store.appendOrReconcilePrompt(sessionTabId, nodeToAppend);
          return;
        }
        // Not a bare append: a late tail record must land above an already-echoed queued prompt.
        store.appendCliRecord(sessionTabId, nodeToAppend);
      }
    } catch (err) {
      // Direct to app_logs, not console.error: LogService batches every 2s and the toast must be immediate.
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
        // IPC is gone; do not fall back to console.error.
      });
    }
  }, [projectPath, sessionTabId, setPendingPermission]);

  const {
    unlistenRefs,
    isMountedRef,
    startPersistentSession,
    rebindPersistentSession,
    sessionStatus,
    turn,
    conversationStatus,
    resetStatus,
    launchPermissionMode,
  } = useSessionLifecycle({
    tabId: tabIdRef.current,
    projectPath,
    selectedModel,
    permissionMode,
    effort,
    agent,
    accountResolution,
    persistentSessionRef,
    // Seed 'starting' when a start is pending, avoiding a one-frame flash of the empty form.
    hasPendingStart: !!session || !!initialSessionConfig,
    handleJsonlLine,
    setMessages,
    onSessionInit: useCallback((sessionId: string) => {
      streamCtxRef.current.setClaudeSessionId(sessionId);
      const projectId = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
      streamCtxRef.current.setExtractedSessionInfo({ sessionId, projectId });
      SessionPersistenceService.saveSession(sessionId, projectId, projectPath, 0);
    }, [projectPath]),
    onLivePermissionMode: useCallback((mode: string) => {
      livePermissionModeRef.current = mode;
      setPermissionMode(mode);
    }, []),
    tasks: taskEntries,
    subagents,
  });
  const isSessionStarting = sessionStatus === 'starting';
  const isSessionActive = sessionStatus === 'started';

  // sessionLive is the strict 'started' predicate, not sessionStarted (also true while dialing and after a failed start).
  const sessionStarted = sessionStatus !== 'stopped';
  // The daemon's turn, mirrored; never an optimistic renderer flag.
  const isLoading = turn.status === 'running';
  useEffect(() => { turnRunningRef.current = isLoading; }, [isLoading]);
  useEffect(() => {
    onStreamingChangeRef.current?.(isLoading, claudeSessionId);
  }, [isLoading, claudeSessionId]);
  const outstandingWork = isLoading || tasksInFlight;

  // Starts at turn.since so remote clients agree. lastTurnMs is measured here, not taken from duration_ms (API time), or the frozen counter would jump.
  const turnStartedAt = useMemo<number | null>(() => {
    if (turn.status !== 'running' || turn.since === null) return null;
    const at = Date.parse(turn.since);
    return Number.isFinite(at) ? at : null;
  }, [turn.status, turn.since]);
  const [lastTurnMs, setLastTurnMs] = useState<number | null>(null);
  const turnStartedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (turnStartedAt !== null) {
      turnStartedAtRef.current = turnStartedAt;
      return;
    }
    const startedAt = turnStartedAtRef.current;
    if (startedAt === null) return;
    turnStartedAtRef.current = null;
    setLastTurnMs(Date.now() - startedAt);
    useClaudeSessionStore.getState().pruneToolProgressFor(tabIdRef.current, new Set());
    useClaudeSessionStore.getState().clearPermissionChecks(tabIdRef.current);
  }, [turnStartedAt]);
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

  // Last-value guard: updateTab returns a new tab every call, so an unguarded write loops.
  const lastAgentCountRef = useRef<number | null>(null);
  useEffect(() => {
    if (lastAgentCountRef.current === activeSubagentCount) return;
    lastAgentCountRef.current = activeSubagentCount;
    updateTab(tabIdRef.current, { activeAgents: activeSubagentCount });
  }, [activeSubagentCount, updateTab]);

  const tabWaitingFor: TabWaitingFor = deriveWaitingFor(pendingPermission);
  const lastWaitingForRef = useRef<TabWaitingFor | undefined>(undefined);
  useEffect(() => {
    if (lastWaitingForRef.current === tabWaitingFor) return;
    lastWaitingForRef.current = tabWaitingFor;
    updateTab(tabIdRef.current, { waitingFor: tabWaitingFor });
  }, [tabWaitingFor, updateTab]);

  usePublishTabStatus({
    tabId: tabIdRef.current,
    title: tabTitle,
    projectPath: projectPath ?? null,
    // The GUID, not the renderer-local tab id.
    sessionId: claudeSessionId ?? null,
    sessionStarted: isSessionActive,
    isStarting: isSessionStarting,
    turnRunning: turn.status === 'running',
    hasError: error !== null,
    messages,
    subagents,
    contextUsage,
    branch: gitStatus?.branch ?? null,
    filesChanged: gitStatus?.changed ?? 0,
    filesUntracked: gitStatus?.untracked ?? 0,
    pendingPermission,
  });

  const { handleSendPrompt: sendPromptRaw, queuedPrompts, setQueuedPrompts, queuedPromptsRef } = useSendPrompt({
    projectPath,
    tabId: tabIdRef.current,
    turnRunningRef,
    selectedModel,
    persistentSessionRef,
    unlistenRefs,
    effectiveSession,
    claudeSessionId,
    sessionMetrics,
    startPersistentSession,
    pickGerund,
    setError,
    setCurrentActivity,
    setSelectedModel,
    setMessages,
    onSideChat: agent === 'codex' ? undefined : routeToSideChat,
  });

  const handleSendPrompt = useCallback(
     
    (prompt: string, model: string, images?: string[], opts?: SendPromptOptions) => {
      isNearBottomRef.current = true;
      return sendPromptRaw(prompt, model, images, opts);
    },
    [sendPromptRaw],
  );

  const handleCompact = useCallback(() => {
    void handleSendPrompt('/compact', selectedModel);
  }, [selectedModel, handleSendPrompt]);

  const handleRecap = useCallback(() => {
    void handleSendPrompt('/recap', selectedModel);
  }, [selectedModel, handleSendPrompt]);

  // Stable: a fresh onResend per render defeats React.memo on every StreamMessage.
  const handleResend = useCallback(
    (text: string, images: string[] | undefined) =>
      handleSendPrompt(text, selectedModel, images),
    [handleSendPrompt, selectedModel],
  );
  const onResendStable = useMemo(
    () => fireAndLog('claude-code-session:resend', handleResend),
    [handleResend],
  );

  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  const changePermissionMode = useCallback((mode: string) => {
    void changeSessionPermissionMode(mode, {
      tabId: tabIdRef.current,
      hasLiveSession: !!persistentSessionRef.current,
      previous: permissionModeRef.current,
      api,
      setPermissionMode: (m) => {
        if (livePermissionModeRef.current !== null) livePermissionModeRef.current = m;
        setPermissionMode(m);
      },
      appendMessage,
      onError: (err) => {
        console.error('[sessions] sessionSetPermissionMode failed:', err);
        const name = PERMISSION_MODES.find((m) => m.id === mode)?.name ?? mode;
        setError(`Couldn't switch permissions to ${name}: ${err instanceof Error ? err.message : String(err)}`);
      },
    });
  }, [appendMessage]);

  // Callbacks read refs so the value changes only with displayed fields; every StreamMessage is mounted at once.
  const [homeDir, setHomeDir] = useState('');
  useEffect(() => {
    api.getHomeDirectory().then(setHomeDir).catch(() => { });
  }, []);
  const sessionActionRefs = useRef({ handleSendPrompt, selectedModel, changePermissionMode, configDir: '' });
  sessionActionRefs.current = {
    handleSendPrompt,
    selectedModel,
    changePermissionMode,
    configDir: accountResolution?.account.config_dir ?? '',
  };
  const sessionActions = useMemo<SessionActions>(() => ({
    projectPath,
    homeDir,
    permissionMode,
    turnRunning: isLoading,
    sendPrompt: (text) => {
      const { handleSendPrompt: send, selectedModel: model } = sessionActionRefs.current;
      if (queueHeldRef.current && !turnRunningRef.current) {
        const rest = queuedPromptsRef.current.filter(p => p.prompt !== text);
        queuedPromptsRef.current = rest;
        setQueuedPrompts(rest);
      }
      void send(text, model, undefined, { front: true });
    },
    addAllowRule: (rule) => api.sessionUpdatePermission(tabIdRef.current, projectPath, sessionActionRefs.current.configDir, {
      action: 'add',
      scope: 'local',
      behavior: 'allow',
      rule,
    }),
    setPermissionMode: (mode) => sessionActionRefs.current.changePermissionMode(mode),
  }), [projectPath, homeDir, permissionMode, isLoading, queuedPromptsRef, setQueuedPrompts]);

  // Ref-captured: the auto-start promise resolves later and needs the current send path.
  const initialPromptRef = useRef(initialPrompt);
  const initialPromptSentRef = useRef(false);
  const fireInitialPromptRef = useRef<() => void>(() => {});
  fireInitialPromptRef.current = () => {
    const prompt = initialPromptRef.current;
    if (!prompt || initialPromptSentRef.current) return;
    // Latch before sending and clear from the tab, or a re-render or restore double-sends.
    initialPromptSentRef.current = true;
    initialPromptRef.current = undefined;
    onInitialPromptSent?.();
    void handleSendPrompt(prompt, selectedModel);
  };

  streamCtxRef.current.handleSendPrompt = handleSendPrompt;
  streamCtxRef.current.isMountedRef = isMountedRef;
  streamCtxRef.current.queuedPromptsRef = queuedPromptsRef;
  streamCtxRef.current.setQueuedPrompts = setQueuedPrompts as unknown as (next: unknown) => void;

  // On renderer reload, rebind: tearing down a healthy session leaves the new query unable to receive input.
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
        // sessionRebind is keyed by tabId: rebind only when the live session IS the one opened, or a reused tab attaches to the wrong session.
        const health = await api.sessionGetHealth(tabIdRef.current).catch(() => null);
        const target = decideRebindTarget({
          healthAlive: !!health?.alive,
          healthSessionId: health?.sessionId ?? null,
          selectedSessionId: session.id,
        });
        if (target === 'rebind') {
          const rebound = await rebindPersistentSession();
          if (!rebound) {
            await startPersistentSession(session.id);
          }
          return;
        }
        if (health?.alive) {
          await api.stopSession(tabIdRef.current).catch(() => {});
        }
        await startPersistentSession(session.id);
      })().catch((err: unknown) => { console.error("[auto-start] resume/rebind failed:", err); });
    } else if (action === 'fresh-start') {
      startPersistentSession()
        .then(() => { fireInitialPromptRef.current(); })
        .catch((err: unknown) =>
          { console.error("[auto-start] fresh start failed:", err); },
        );
    }
  }, [isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unlisten = window.electronAPI.onEvent(
      `elicitation-request:${tabIdRef.current}`,
      (payload: unknown) => {
        setElicitationRequest((payload as ElicitationRequest | null) ?? null);
      },
    );
    return () => { unlisten(); };
  }, []);

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
        const payload = args[0] as RateLimitUpdate | undefined;
        setRateLimitSnapshots((prev) => applyRateLimitUpdate(prev, payload, activeAccountName));
      },
    );
    return () => {
      cancelled = true;
      unlisten();
    };
  }, [activeAccountName]);

  useEffect(() => {
    const unlisten = window.electronAPI.onEvent(
      `session-account-mismatch:${tabIdRef.current}`,
      (...args: unknown[]) => {
        const payload = args[0] as AccountMismatch | undefined;
        if (payload) setAccountMismatch(payload);
      },
    );
    return () => { unlisten(); };
  }, []);

  useEffect(() => {
    if (sessionVerification?.status === 'verified' && accountMismatch) {
      setAccountMismatch(null);
    }
  }, [sessionVerification?.status, accountMismatch]);

  useEffect(() => {
    queuedPromptsRef.current = queuedPrompts;
  }, [queuedPrompts, queuedPromptsRef]);

  // Write the ref too: the drain runs synchronously after this and must send the new text.
  const saveQueuedPromptEdit = (id: string, prompt: string) => {
    const next = queuedPromptsRef.current.map(p => (p.id === id ? { ...p, prompt } : p));
    queuedPromptsRef.current = next;
    setQueuedPrompts(next);
  };

  // A turn that ended mid-edit skipped its drain, so releasing must send.
  const handleQueuedPromptEditing = (id: string | null) => {
    editingPromptIdRef.current = id;
    if (id !== null) return;
    drainQueuedPrompt({
      queuedPromptsRef,
      setQueuedPrompts,
      turnRunningRef,
      editingPromptIdRef,
      queueHeldRef,
      handleSendPrompt: fireAndLog('claude-code-session:send-prompt-edited', handleSendPrompt),
    });
  };

  const resumeQueue = () => {
    setQueueHeld(false);
    drainQueuedPrompt({
      queuedPromptsRef,
      setQueuedPrompts,
      turnRunningRef,
      editingPromptIdRef,
      queueHeldRef,
      handleSendPrompt: fireAndLog('claude-code-session:send-prompt-resumed', handleSendPrompt),
    });
  };

  const sendQueuedPromptNow = (id: string) => {
    const item = queuedPromptsRef.current.find(p => p.id === id);
    if (!item || turnRunningRef.current) return;
    const rest = queuedPromptsRef.current.filter(p => p.id !== id);
    queuedPromptsRef.current = rest;
    setQueuedPrompts(rest);
    fireAndLog('claude-code-session:send-prompt-now', handleSendPrompt)(item.prompt, item.model, item.images);
  };

  useEffect(() => {
    if (queuedPrompts.length === 0 && queueHeldRef.current) setQueueHeld(false);
  }, [queuedPrompts, setQueueHeld]);

  // Soft interrupt keeps the session alive; fall back to stopSession only if it fails.
  const handleCancelExecution = async () => {
    if (!isLoading) return;

    const tid = tabIdRef.current;

    try {
      // Suppress the CLI's is_error result after a deliberate interrupt.
      userInterruptedRef.current = true;

      await api.sessionInterrupt(tid);

      // Session stays alive: don't clean up listeners or unset persistentSessionRef.
      setError(null);
      if (queuedPromptsRef.current.length > 0) setQueueHeld(true);

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
      console.error("sessionInterrupt failed, falling back to stopSession:", err);

      try {
        await api.stopSession(tid);
      } catch (stopErr) {
        console.error("stopSession also failed:", stopErr);
      }

      unlistenRefs.current.forEach((unlisten) => { unlisten(); });
      unlistenRefs.current = [];

      persistentSessionRef.current = false;
      resetStatus({ sessionStatus: 'stopped', conversationStatus: null });
      setError(null);
      if (queuedPromptsRef.current.length > 0) setQueueHeld(true);

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

  const handleReconnect = async () => {
    const tid = tabIdRef.current;

    // rebindPersistentSession short-circuits while the ref is true.
    persistentSessionRef.current = false;

    // Rebind before any stop: stopping first guarantees rebind fails.
    const rebound = await rebindPersistentSession().catch(() => false);
    if (rebound) return;

    try { await api.stopSession(tid); } catch { /* best effort */ }

    unlistenRefs.current.forEach((u) => { u(); });
    unlistenRefs.current = [];

    resetStatus({ sessionStatus: 'stopped', conversationStatus: null });
    setError(null);

    try {
      await startPersistentSession(claudeSessionId ?? undefined);
    } catch (err) {
      console.error('reconnect: startPersistentSession failed:', err);
      setError('Failed to reconnect: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  // Not handleReconnect: a rebind reattaches the process holding the wrong account's credentials.
  const handleRestartSession = async (options?: { permissionMode?: string }) => {
    const tid = tabIdRef.current;
    setRestartingSession(true);
    try {
      persistentSessionRef.current = false;
      try { await api.stopSession(tid); } catch { /* best effort */ }

      unlistenRefs.current.forEach((u) => { u(); });
      unlistenRefs.current = [];

      resetStatus({ sessionStatus: 'stopped', conversationStatus: null });
      setError(null);
      setAccountMismatch(null);
      setSdkAccountInfo(null);

      await startPersistentSession(claudeSessionId ?? undefined, options);
    } catch (err) {
      console.error('restart: startPersistentSession failed:', err);
      setError('Failed to restart session: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRestartingSession(false);
    }
  };

  // A process that lost its sign-in never picks up a new one.
  const sessionAuthFailure = useSessionAuthExpiry({
    messages,
    sessionStatus,
    turnRunning: isLoading,
    configDir: accountResolution?.account.config_dir ?? null,
    restart: handleRestartSession,
  });

  const handleClear = async () => {
    if (!isSessionActive || isLoading || waitingForPermission) return;
    const tid = tabIdRef.current;

    try {
      await api.stopSession(tid);
    } catch (err) {
      console.error('clear: stopSession failed:', err);
    }

    unlistenRefs.current.forEach((unlisten) => { unlisten(); });
    unlistenRefs.current = [];

    persistentSessionRef.current = false;
    resetStatus({ sessionStatus: 'stopped', conversationStatus: null });
    setError(null);
    setQueuedPrompts([]);
    setQueueHeld(false);

    setMessages([]);
    setTotalTokens(0);
    setSessionCost(0);
    costSeenKeysRef.current = new Set();
    setClaudeSessionId(null);
    setContextUsage(null);
    setSdkAccountInfo(null);
    setExtractedSessionInfo(null);
    setAccountMismatch(null);

    try {
      await startPersistentSession();
    } catch (err) {
      console.error('clear: startPersistentSession failed:', err);
    }
  };

  const messagesList = agent === 'codex' ? (
    <CodexTranscript
      messages={codexMessages}
      tabId={tabIdRef.current}
      onOpenInspector={openInspector}
      inspectorOpen={inspectorOpen}
    />
  ) : (
    <SessionActionsProvider value={sessionActions}>
      <ClaudeTranscript
        messages={messages}
        viewMode={viewMode}
        accountType={accountResolution?.account.subscription_label}
        configDir={accountResolution?.account.config_dir ?? null}
        onResend={onResendStable}
        waitingForPermission={waitingForPermission}
        outstandingWork={outstandingWork}
        hasInflightAssistant={hasInflightAssistant}
        currentActivity={currentActivity}
                contextLimit={contextLimit}
        error={error}
        tabId={tabIdRef.current}
        messagesEndRef={messagesEndRef}
        isNearBottomRef={isNearBottomRef}
        onOpenInspector={openInspector}
        inspectorOpen={inspectorOpen}
        jumpTo={transcriptJump}
      />
    </SessionActionsProvider>
  );

  // Back keeps the CLI alive, so regen the summary here under the same enabled && autoOnClose gate; the service dedups against tab close.
  const swipeRef = useRef<HTMLDivElement>(null);
  const layoutMode = useLayoutMode();
  useSwipeTabs(swipeRef, layoutMode.touch);

  const handleBackToProject = () => {
    if (claudeSessionId && projectPath) {
      // The tab's resolved configDir, never the default ~/.claude.
      const configDir = accountResolution?.account.config_dir ?? null;
      void maybeAutoGenerateSummaryOnLeave(claudeSessionId, projectPath, configDir);
    }
    window.dispatchEvent(new CustomEvent('back-to-project', { detail: { projectPath } }));
  };

  const signals = useSessionSignals({
    tabId: tabIdRef.current,
    messages,
    contextTokens: gaugeTokens,
    contextLimit,
    pressureSetting: contextPressureSetting,
    jumpSetting: contextJumpSetting,
    sessionLive: isSessionActive,
    turnInFlight: turn.status === 'running',
    turnStartedAt,
    lastTurnMs,
    cacheTtlChange,
    mcpErrors: mcpServerErrors,
    usageLimitResetsAt,
    accountMismatch,
    accountRestartable: sessionVerification?.needsRestart === true,
    handlers: {
      onCompact: handleCompact,
      onSnoozeBoundary: () => {},
      onRaiseContextBudget: (tokens) => {
        logAndForget('claude-code-session:raise-context-budget', setContextPressure({ ...contextPressureSetting, mode: 'tokens', value: tokens }));
      },
      onRestartSession: () => { void handleRestartSession(); },
    },
  });

  const sessionActivity = signals.stateFor('session.activity');
  const contextLevel = signals.stateFor('context.level');
  const sessionEvents = signals.eventsFor('session', POPOVER_EVENT_LIMIT);
  const sessionAction = signals.actionsFor('session')[0] ?? null;
  // No `account` badge: that anchor has no counting emitter, so it would show zero forever.
  const mcpUnread = signals.unreadFor('mcp');
  const mcpEvents = signals.eventsFor('mcp', POPOVER_EVENT_LIMIT);

  const displayStatus: 'starting' | 'active' | 'ended' | undefined =
    !sessionStarted
      ? undefined
      : isSessionActive
        ? 'active'
        : isSessionStarting
          ? 'starting'
          : 'ended';

  // The config dir's current login, not the session's reported identity.
  const accountSignedInEmail =
    identityLoaded && !identityError && identityVerdict &&
    identityVerdict.status !== "unknown-account"
      ? identityVerdict.detected
      : undefined;
  const accountOnRestart =
    sessionVerification?.needsRestart || sessionAuthFailure
      ? () => { void handleRestartSession(); }
      : null;

  // Once per session view, shared by widget and readout; see useAccountUsage.
  const accountUsage = useAccountUsage({
    accountName: accountResolution?.account.name ?? null,
    hasCost: accountResolution?.account.has_cost === true,
    sessionActive: displayStatus === 'active',
    configDir: accountResolution?.account.config_dir,
    projectPath,
    sessionId: claudeSessionId,
  });

  const subagentCost = accountUsage.subagentCost;
  const backgroundWithCost = useMemo<BackgroundWork>(
    () => ({ ...backgroundWork, subagentCost }),
    [backgroundWork, subagentCost],
  );

  // Resumes never fetch usage, so pull once. Re-runs only on the active flag or contextUsage clearing, so it can't loop.
  useEffect(() => {
    if (displayStatus !== 'active' || contextUsage != null) return;
    const tabId = tabIdRef.current;
    let cancelled = false;
    api.sessionContextUsage(tabId)
      .then((usage) => {
        if (!cancelled && usage) streamCtxRef.current.setContextUsage(usage);
      })
      .catch(() => { });
    return () => { cancelled = true; };
  }, [displayStatus, contextUsage]);

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
  const confirmAndClear = (): void => {
    if (window.confirm('Clear the conversation and start a fresh session? This wipes all messages in this tab and cannot be undone.')) {
      void handleClear();
    }
  };

  const renderStatusBar = (inHeaderRow: boolean): React.JSX.Element => (
    <ChatStatusBar
      className={inHeaderRow ? "p-0 bg-transparent" : undefined}
      link={daemonLink}
      activitySignal={sessionActivity}
      cacheAnchorMs={cacheAnchorMs}
      cacheTtlMs={cacheTtlMs}
      title={sessionTitle}
      // Renaming needs the live session's control channel.
      canRename={isSessionActive}
      onRename={handleRenameSession}
      onSuggest={handleSuggestTitle}
      background={backgroundWithCost}
      account={
        accountResolution ? (
          <AccountStatusItem
            accountName={accountResolution.account.name}
            hasCost={accountResolution.account.has_cost}
            agent={agent}
            configDir={accountResolution.account.config_dir}
            matchType={accountResolution.match_type}
            matchDetail={accountResolution.match_detail}
            verification={sessionVerification}
            signedInEmail={accountSignedInEmail}
            onRecheck={recheckIdentity}
            sessionAuthFailure={sessionAuthFailure}
            onRestart={accountOnRestart}
            restarting={restartingSession}
            sdkAccount={sdkAccountInfo}
            usage={accountUsage}
            fiveHourRateLimit={rateLimitSnapshots.five_hour ?? null}
            sevenDayRateLimit={rateLimitSnapshots.seven_day ?? null}
          />
        ) : undefined
      }
      session={
        <SessionStatusItem
          totalTokens={totalTokens}
          contextLimit={contextLimit}
          contextUsage={contextUsage}
          contextLevelSignal={contextLevel}
          sessionStatus={displayStatus}
          promptStatus={promptStatus}
          waitingFor={tabWaitingFor}
          sessionId={claudeSessionId}
          pendingAction={sessionAction}
          recentEvents={sessionEvents}
          onSignalsRead={() => { signals.markRead('session'); }}
          onCompact={fireAndLog('claude-code-session:compact', handleCompact)}
          compactDisabled={isLoading || !isSessionActive}
          loadout={loadout}
          onOpenLoadout={openContextPanel}
          onJumpToMessage={jumpToMessage}
        />
      }
      controls={
        <SessionControlPickers
          engine={agent}
          configDir={accountResolution?.account.config_dir}
          activeDefaultModel={liveDefaultEvidence(selectedModel, liveDefaultModel)}
          defaultPermissionMode={accountResolution?.account.session_defaults?.permissionMode ?? null}
          catalogRefreshKey={catalogRefreshKey}
          model={selectedModel}
          setModel={(newModel) => {
            void changeSessionModel(newModel, {
              tabId: tabIdRef.current,
              hasLiveSession: !!persistentSessionRef.current,
              previous: selectedModel,
              api,
              setSelectedModel,
              setContextUsage,
              appendMessage,
              onError: (err) => {
                console.error('[sessions] sessionSetModel failed:', err);
                setError(`Couldn't switch the model to ${newModel}: ${err instanceof Error ? err.message : String(err)}`);
              },
            });
          }}
          effort={effort}
          setEffort={(level) => {
            setEffort(level as EffortLevel);
            if (persistentSessionRef.current) {
              const tid = tabIdRef.current;
              api.sessionSetEffort(tid, level as EffortLevel).then(() => {
                // Effort never reaches the JSONL; this marker is its only record.
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
          setPermissionMode={changePermissionMode}
          // The CLI allows mid-session Bypass only for a process spawned in it; restart instead.
          onRestartInBypass={
            agent === 'claude' && isSessionActive && launchPermissionMode !== 'bypassPermissions'
              ? () => {
                  setPermissionMode('bypassPermissions');
                  void handleRestartSession({ permissionMode: 'bypassPermissions' });
                }
              : undefined
          }
          checkingPermissions={checkingPermissions}
        />
      }
    />
  );

  const gitBar = sessionGit ? (
    <BranchStatusBar
      snapshot={sessionGit}
      pins={branchPins}
      aliases={repoAliases}
      onViewChanges={(path, label) => { setDiffTarget(label === undefined ? { path } : { path, label }); }}
      onOpenRepos={() => { setReposDialogOpen(true); }}
      watch={gitWatchId ? (
        <GitWatchStatusIcon
          errors={gitWatchErrors}
          onReconnect={() => api.reconnectSessionGitWatch(gitWatchId)}
          snapshotKey={sessionGit}
        />
      ) : undefined}
    />
  ) : null;

  return (
    <TooltipProvider>
      <div ref={swipeRef} className={cn("flex flex-col h-full bg-background", className)}>
        <CaughtUpPill tabId={tabIdRef.current} />
        {/* headerRef wraps only the resizable row; the status bar is fixed-height, so the handle's delta is the row's. */}
        <div
          className="relative shrink-0 border-b border-border/30 bg-muted transition-shadow duration-150"
          // Inline, not a border-* utility: the unlayered `* { border-color }` in styles.css outranks them. The glow is a shadow for the same reason.
          style={headerResizing ? {
            borderBottomColor: 'var(--color-ring)',
            boxShadow: '0 1px 6px -1px color-mix(in oklch, var(--color-ring) 55%, transparent)',
          } : undefined}
        >
          <div
            ref={headerRef}
            className="relative flex items-start gap-2 px-4 py-1.5"
            style={headerHeight != null ? { height: Math.max(headerHeight, headerMinHeight) } : undefined}
          >
            <div ref={backColRef} className="flex gap-1">
              <BackButton
                label="Back to Project page"
                onClick={handleBackToProject}
                size={SHOW_HEADER_WIDGETS ? "lg" : "sm"}
              />
              {!SHOW_HEADER_WIDGETS && (
                <NewSessionButton
                  onClick={confirmAndClear}
                  disabled={clearButtonDisabled}
                  reason={clearButtonReason}
                />
              )}
            </div>
            <span aria-hidden="true" className="self-stretch w-px bg-foreground/30 shrink-0 mx-1" />
            {SHOW_HEADER_WIDGETS && accountResolution && (
              <div className="relative flex">
              <AccountCard
                accountName={accountResolution.account.name}
                hasCost={accountResolution.account.has_cost}
                agent={agent}
                configDir={accountResolution.account.config_dir}
                matchType={accountResolution.match_type}
                matchDetail={accountResolution.match_detail}
                verification={sessionVerification}
                signedInEmail={accountSignedInEmail}
                onRecheck={recheckIdentity}
                sessionAuthFailure={sessionAuthFailure}
                onRestart={accountOnRestart}
                restarting={restartingSession}
                sdkAccount={sdkAccountInfo}
                usage={accountUsage}
                fiveHourRateLimit={rateLimitSnapshots.five_hour ?? null}
                sevenDayRateLimit={rateLimitSnapshots.seven_day ?? null}
              />
              </div>
            )}
            {SHOW_HEADER_WIDGETS ? <div ref={branchColRef}>{gitBar}</div> : (
              // Measured for the header's minimum height: both bars.
              <div ref={branchColRef} className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
                <div className="w-full">{renderStatusBar(true)}</div>
                {gitBar}
              </div>
            )}
            {SHOW_HEADER_WIDGETS && <SessionCard
              className="ml-auto min-w-0"
              activitySignal={sessionActivity}
              contextLevelSignal={contextLevel}
              pendingAction={sessionAction}
              recentEvents={sessionEvents}
              onSignalsRead={() => { signals.markRead('session'); }}
              // Permanent: the boundary action fires only at 100% of the budget.
              onCompact={fireAndLog('claude-code-session:compact', handleCompact)}
              compactDisabled={isLoading || !isSessionActive}
              totalTokens={totalTokens}
              contextLimit={contextLimit}
              contextUsage={contextUsage}
              sessionStatus={displayStatus}
              onReconnect={() => void handleReconnect()}
              onClear={confirmAndClear}
              clearDisabled={clearButtonDisabled}
              clearReason={clearButtonReason}
              sessionId={claudeSessionId}
              controlsSummary={
                agent === 'claude'
                  ? sessionControlSummary({
                      model: selectedModel,
                      liveModel: liveDefaultModel,
                      accountDefaultModel,
                      models: effectiveModels(supportedModels),
                      raw: supportedModels,
                      effort,
                      permissionMode,
                    })
                  : undefined
              }
            />}
          </div>
          {SHOW_HEADER_WIDGETS && renderStatusBar(false)}
          <SessionHeaderResizeHandle
            resizing={headerResizing}
            canReset={headerHeight != null}
            onPointerDown={handleHeaderResizeStart}
            onDoubleClick={handleHeaderResizeReset}
          />
        </div>
        {shouldShowNewSessionPanel({ sessionStarted, hasTranscript: messages.length > 0 }) && (
          <div className="flex-1 flex items-center justify-center p-8">
            <NewSessionForm
              resolvePair={resolvePair}
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
              effort={effort}
              setEffort={setEffort}
              permissionMode={permissionMode}
              setPermissionMode={setPermissionMode}
              agent={agent}
              setAgent={setAgent}
              agentPickerDisabled={isSessionStarting}
              onStart={() => {
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
        <div className="flex-1 min-h-0 w-full flex flex-row">
        <div className="flex-1 min-h-0 min-w-0 flex flex-col relative">

        <div className="flex-1 min-h-0 overflow-hidden relative">
          <SessionSidePanels
            open={sidePanel}
            onClose={() => { setSidePanel(null); }}
            actions={{
              context: (
                <SessionContextRefreshButton
                  busy={sessionPlugins.plugins === null || sessionMcp.servers === null}
                  onRefresh={refreshSessionContext}
                />
              ),
            }}
            content={{
              inspector: (
                <SessionInspectorPanel
                  sessionId={claudeSessionId}
                  status={displayStatus}
                  sessionStatus={sessionStatus}
                  conversationStatus={conversationStatus}
                  model={selectedModel}
                  account={accountResolution ? {
                    name: accountResolution.account.name,
                    configDir: accountResolution.account.config_dir,
                  } : null}
                  projectPath={projectPath ?? null}
                  branch={gitStatus?.branch ?? null}
                  promptStatus={promptStatus}
                  turn={turn}
                  activeAgents={activeSubagentCount}
                  tasks={{
                    total: taskListSummary.total,
                    inProgress: taskListSummary.inProgress,
                    completed: taskListSummary.done,
                    pending: taskListSummary.pending,
                  }}
                />
              ),
              permissions: (
                <div className="h-full overflow-y-auto">
                  <SessionPermissionsEditor
                    tabId={tabIdRef.current}
                    projectPath={projectPath}
                    configDir={accountResolution?.account.config_dir || ''}
                  />
                </div>
              ),
              context: (
                <SessionContextPanel
                  plugins={sessionPlugins.plugins}
                  modStatus={modStatus}
                  mcpCount={sessionMcp.servers?.length ?? initMcpCount}
                  mcp={
                    <>
                      <SessionMCPStatus
                        servers={sessionMcp.servers}
                        tabId={tabIdRef.current}
                        watchUntil={sessionMcp.watchUntil}
                        configDir={accountResolution?.account.config_dir ?? null}
                      />
                      <div className="px-2 pb-2">
                        <div className="px-1.5 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                          Recent events
                        </div>
                        <SignalEventLog events={mcpEvents} />
                      </div>
                    </>
                  }
                  instructionsCount={contextLedger.tracked ? contextLedger.entries.length : null}
                  instructions={<ContextLedgerPanel ledger={contextLedger} />}
                />
              ),
            }}
          />
          {projectPath && (
            <ProjectReposDialog projectPath={projectPath} open={reposDialogOpen} onOpenChange={setReposDialogOpen} />
          )}
          {diffTarget && (
            <GitDiffOverlay
              key={diffTarget.path}
              projectPath={diffTarget.path}
              label={diffTarget.label}
              refreshToken={gitRefreshToken}
              onClose={() => { setDiffTarget(null); }}
            />
          )}
          <div className="h-full flex flex-col">
            {messagesList}
            
            {historyLoading && messages.length === 0 && session && <TranscriptSkeleton className="px-4 pt-8 pb-4" />}
            {historyLoading && messages.length === 0 && !session && (
              <div className="flex items-center justify-center h-full">
                <div className="flex items-center gap-3">
                  <div className="rotating-symbol text-primary" />
                  <span className="text-sm text-muted-foreground">
                    Initializing Claude Code...
                  </span>
                </div>
              </div>
            )}
          </div>

          <AnimatePresence>
            {sessionStarted && queuedPrompts.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 w-full max-w-3xl px-4"
              >
                <QueuedPromptsPanel
                  prompts={queuedPrompts}
                  modelLabel={(model) => modelPickerLabel(model, supportedModels, accountDefaultModel, liveDefaultEvidence(selectedModel, liveDefaultModel))}
                  onRemove={(id) => { setQueuedPrompts(prev => prev.filter(p => p.id !== id)); }}
                  onSave={saveQueuedPromptEdit}
                  onRemoveImage={(id, index) => { setQueuedPrompts(prev => withoutQueuedImage(prev, id, index)); }}
                  onEditingChange={handleQueuedPromptEditing}
                  held={queueHeld && !isLoading}
                  onResume={resumeQueue}
                  onSendNow={sendQueuedPromptNow}
                />
              </motion.div>
            )}
          </AnimatePresence>

        </div>

        {sessionStarted && <ErrorBoundary>
          <ElicitationDialog
            request={elicitationRequest}
            openUrl={(url) => window.electronAPI.openExternal(url)}
            onAccept={(requestId, content) => {
              logAndForget('claude-code-session:respond-elicitation', api.respondElicitation(tabIdRef.current, 'accept', content, requestId));
              setElicitationRequest(null);
            }}
            onDecline={(requestId) => {
              logAndForget('claude-code-session:respond-elicitation', api.respondElicitation(tabIdRef.current, 'decline', undefined, requestId));
              setElicitationRequest(null);
            }}
            onCancel={(requestId) => {
              logAndForget('claude-code-session:respond-elicitation', api.respondElicitation(tabIdRef.current, 'cancel', undefined, requestId));
              setElicitationRequest(null);
            }}
          />

          <div className="shrink-0 z-50">
            {pendingPermission && (
              pendingPermission.toolName === 'AskUserQuestion' ? (
                <ModernQuestionCard
                  request={pendingPermission}
                  onSubmit={(updatedInput) => {
                    handlePermissionAllowWithInput(tabIdRef.current, updatedInput);
                  }}
                  onCancel={() => {
                    handlePermissionDeny(tabIdRef.current);
                  }}
                />
              ) : (
                <ModernPermissionCard
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
            <AttentionSlot queue={signals.queue} onDismiss={signals.dismiss} />
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
              supportedCommands={supportedCommands}
              isActive={isActive}
              outputStyleToggle={
                <div className="flex flex-col gap-0.5 w-full">
                  <HeaderLabel className="px-0.5">chat format</HeaderLabel>
                  <SessionViewToggle className="w-full" mode={viewMode} onChange={setViewMode} />
                  {agent !== 'codex' && (
                    <TooltipSimple content="Ask Claude where this session stands (/recap)" side="top">
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full h-6 mt-1 text-xs"
                        disabled={!projectPath}
                        onClick={handleRecap}
                      >
                        Recap
                      </Button>
                    </TooltipSimple>
                  )}
                </div>
              }
              extraMenuItems={
                <>
                  {agent !== 'codex' && (
                    <TooltipSimple content="Side chat" side="top">
                      <motion.div
                        whileTap={{ scale: 0.97 }}
                        transition={{ duration: 0.15 }}
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Side chat"
                          onClick={openSideChat}
                          className={cn(
                            "h-8 w-8 text-muted-foreground hover:text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent)]",
                            sideChatVisible ? "bg-accent" : "bg-background",
                          )}
                        >
                          <MessageCircleQuestion className={cn("h-3.5 w-3.5", sideChatVisible && "text-primary")} />
                        </Button>
                      </motion.div>
                    </TooltipSimple>
                  )}
                  <TooltipSimple content="Permissions" side="top">
                    <motion.div
                      whileTap={{ scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => { toggleSidePanel('permissions'); }}
                        className={cn(
                          "h-8 w-8 text-muted-foreground hover:text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent)]",
                          sidePanel === 'permissions' ? "bg-accent" : "bg-background",
                        )}
                      >
                        <Shield className={cn("h-3.5 w-3.5", sidePanel === 'permissions' && "text-primary")} />
                      </Button>
                    </motion.div>
                  </TooltipSimple>
                  <TooltipSimple content="Session context — mods, plugins, MCP servers, instructions" side="top">
                    {/* `relative` hosts the unread badge. */}
                    <motion.div
                      className="relative"
                      whileTap={{ scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                    >
                      <SignalBadge count={mcpUnread} label="MCP" />
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => { if (sidePanel !== 'context') signals.markRead('mcp'); toggleSidePanel('context'); }}
                        className={cn(
                          "h-8 w-8 text-muted-foreground hover:text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent)]",
                          sidePanel === 'context' ? "bg-accent" : "bg-background",
                        )}
                      >
                        <Layers className={cn("h-3.5 w-3.5", sidePanel === 'context' && "text-primary")} />
                      </Button>
                    </motion.div>
                  </TooltipSimple>
                </>
              }
            />
          </div>

        </ErrorBoundary>}

      </div>
        <AnimatePresence>
          {sideChatVisible && (
            <SideChatPanel
              sideChat={sideChat.sideChat}
              askError={sideChat.askError}
              onAsk={sideChat.ask}
              onClose={closeSideChat}
              focusRequest={sideChatFocus}
            />
          )}
        </AnimatePresence>
      </div>

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
