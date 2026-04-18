import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Copy,
  ChevronDown,
  GitBranch,
  ChevronUp,
  X,
  Wrench,
  BarChart3,
  Plug,
  Shield,
  Send,
  ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover } from "@/components/ui/popover";
import { api, type Session } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AccountBadge } from "@/components/AccountBadge";
import { StreamMessage } from "./StreamMessage";
import {
  FloatingPromptInput,
  type FloatingPromptInputRef,
  type EffortLevel,
  type ThinkingConfig,
  PERMISSION_MODES,
  EFFORT_LEVELS,
} from "./FloatingPromptInput";
import { ErrorBoundary } from "./ErrorBoundary";
import { TimelineNavigator } from "./TimelineNavigator";
import { CheckpointSettings } from "./CheckpointSettings";
import { SlashCommandsManager } from "./SlashCommandsManager";
import { SessionMCPStatus } from "./SessionMCPStatus";
import { PermissionDialog } from "./PermissionDialog";
import { ElicitationDialog } from "./ElicitationDialog";
import { SessionPermissionsEditor } from "./SessionPermissionsEditor";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { TooltipProvider, TooltipSimple } from "@/components/ui/tooltip-modern";
import { SplitPane } from "@/components/ui/split-pane";
import { WebviewPreview } from "./WebviewPreview";
import type { ClaudeStreamMessage } from "./AgentExecution";
import { synthesizeResultMessages } from "@/lib/synthesizeResults";
import { SessionViewToggle, type ViewMode } from "./SessionViewToggle";
import { CollapsibleGroup, isBoundaryMessage } from "./CollapsibleGroup";
import { SessionHeader } from "./SessionHeader";
import { filterDisplayableMessages } from "@/lib/messageFilters";
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
  const [showTimeline, setShowTimeline] = useState(false);
  const [showMCPPanel, setShowMCPPanel] = useState(false);
  const [showPermissionsPanel, setShowPermissionsPanel] = useState(false);
  const [timelineVersion, setTimelineVersion] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showForkDialog, setShowForkDialog] = useState(false);
  const [usagePopoverOpen, setUsagePopoverOpen] = useState(false);
  const [usageText, setUsageText] = useState<string | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [showSlashCommandsSettings, setShowSlashCommandsSettings] = useState(false);
  const [forkCheckpointId, setForkCheckpointId] = useState<string | null>(null);
  const [forkSessionName, setForkSessionName] = useState("");
  const [accountResolution, setAccountResolution] = useState<{
    account: { name: string; account_type: string; config_dir: string };
    match_type: string;
    match_detail: string;
  } | null>(null);
  const [sessionCost, setSessionCost] = useState(0);
  // Pre-session config: show setup panel for new sessions until user clicks Start
  const [sessionStarted, setSessionStarted] = useState(!!session);
  const [selectedModel, setSelectedModel] = useState<string>("opus[1m]");
  // Permission mode — the full SDK set ("default" | "acceptEdits" | "plan"
  // | "bypassPermissions"). Pre-session and in-session pickers both use
  // the same PERMISSION_MODES constant from FloatingPromptInput.
  // Default is acceptEdits per user preference — safer than bypass,
  // smoother than ask-every-time.
  const [permissionMode, setPermissionMode] = useState<string>("acceptEdits");
  // Effort level — maps to the SDK's reasoning_effort parameter.
  // Default 'high' matches the SDK's own default (sdk.d.ts EffortLevel docs).
  // There is no 'auto' — the SDK's EffortLevel is strictly low/medium/high/xhigh/max.
  const [effort, setEffort] = useState<EffortLevel>('high');
  // Thinking config — controls extended thinking behavior.
  const [thinkingConfig, setThinkingConfig] = useState<ThinkingConfig>('adaptive');
  // Git branch for the project directory, shown in SessionHeader badge.
  const [gitBranch, setGitBranch] = useState<string | null>(null);

  // Resolve account explanation for SessionHeader
  useEffect(() => {
    if (projectPath) {
      api.explainAccountResolution(projectPath).then((result) => {
        if (result) {
          setAccountResolution(result);
        }
      }).catch(console.error);
    }
  }, [projectPath]);

  // Fetch git branch for the project directory (displayed in SessionHeader).
  useEffect(() => {
    if (projectPath) {
      api.getGitBranch(projectPath).then(setGitBranch).catch(() => setGitBranch(null));
    }
  }, [projectPath]);

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
  const tabIdRef = useRef(tabId || 'default');
  const floatingPromptRef = useRef<FloatingPromptInputRef>(null);
  // Tracks whether the user just hit the cancel/interrupt button. When true,
  // the stream listener suppresses the next error-typed result message (which
  // the SDK emits after interrupt) so "Execution Failed" doesn't flash after
  // a deliberate cancel. Reset after the first result message is consumed.
  const userInterruptedRef = useRef(false);
  const isIMEComposingRef = useRef(false);
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
    checkpointCount: 0,
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

  // Filter out messages that shouldn't be displayed
  const displayableMessages = useMemo(() => filterDisplayableMessages(messages), [messages]);

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
      
      // Convert history to messages format
      const loadedMessages: ClaudeStreamMessage[] = history.map(entry => ({
        ...entry,
        type: entry.type || "assistant"
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
        // Auto-checkpoint after successful turn
        if (effectiveSession) {
          api.getCheckpointSettings(
            effectiveSession.id,
            effectiveSession.project_id,
            projectPath
          ).then((settings) => {
            if (settings.auto_checkpoint_enabled) {
              return api.checkAutoCheckpoint(
                effectiveSession.id,
                effectiveSession.project_id,
                projectPath,
                ''
              );
            }
          }).then(() => {
            setTimelineVersion((v) => v + 1);
          }).catch((err) => {
            console.error('Failed to check auto checkpoint:', err);
          });
        }
      }

      setMessages((prev) => [...prev, message]);
    } catch (err) {
      console.error('Failed to parse message:', err, payload);
    }
  }, [projectPath, effectiveSession, extractedSessionInfo, autoAllowedTools]);

  // Session lifecycle: persistent session management, event listeners, cleanup
  const { unlistenRefs, isMountedRef, startPersistentSession } = useSessionLifecycle({
    tabId: tabIdRef.current,
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

  // Auto-resume restored sessions — when a tab is opened with an existing
  // session (from a previous app run or tab restore), start the SDK
  // subprocess so queries like supportedCommands work immediately.
  useEffect(() => {
    if (session && !persistentSessionRef.current) {
      startPersistentSession(session.id);
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

  const handleCheckpointSelect = async () => {
    // Reload messages from the checkpoint
    await loadSessionHistory();
    // Ensure timeline reloads to highlight current checkpoint
    setTimelineVersion((v) => v + 1);
  };
  
  const handleCheckpointCreated = () => {
    // Update checkpoint count in session metrics
    sessionMetrics.current.checkpointCount += 1;
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

  const handleFork = (checkpointId: string) => {
    setForkCheckpointId(checkpointId);
    setForkSessionName(`Fork-${new Date().toISOString().slice(0, 10)}`);
    setShowForkDialog(true);
  };

  const handleCompositionStart = () => {
    isIMEComposingRef.current = true;
  };

  const handleCompositionEnd = () => {
    setTimeout(() => {
      isIMEComposingRef.current = false;
    }, 0);
  };

  const handleConfirmFork = async () => {
    if (!forkCheckpointId || !forkSessionName.trim() || !effectiveSession) return;
    
    try {
      setIsLoading(true);
      setError(null);
      
      const newSessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      await api.forkFromCheckpoint(
        forkCheckpointId,
        effectiveSession.id,
        effectiveSession.project_id,
        projectPath,
        newSessionId,
        forkSessionName
      );
      
      // Open the new forked session
      // You would need to implement navigation to the new session
      console.log("Forked to new session:", newSessionId);
      
      setShowForkDialog(false);
      setForkCheckpointId(null);
      setForkSessionName("");
    } catch (err) {
      console.error("Failed to fork checkpoint:", err);
      setError("Failed to fork checkpoint");
    } finally {
      setIsLoading(false);
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
                  />
                </div>
              ))
            : (() => {
                const items: Array<
                  | { kind: 'single'; message: ClaudeStreamMessage; key: string }
                  | { kind: 'group'; messages: ClaudeStreamMessage[]; key: string }
                > = [];
                displayableMessages.forEach((message, idx) => {
                  if (isBoundaryMessage(message)) {
                    items.push({ kind: 'single', message, key: `m-${idx}` });
                  } else {
                    const last = items[items.length - 1];
                    if (last && last.kind === 'group') {
                      last.messages.push(message);
                    } else {
                      items.push({ kind: 'group', messages: [message], key: `g-${idx}` });
                    }
                  }
                });
                return items.map((item) =>
                  item.kind === 'single' ? (
                    <div key={item.key}>
                      <StreamMessage
                        message={item.message}
                        streamMessages={messages}
                        onLinkDetected={handleLinkDetected}
                        accountType={accountResolution?.account.account_type}
                      />
                    </div>
                  ) : (
                    <CollapsibleGroup
                      key={item.key}
                      messages={item.messages}
                      streamMessages={messages}
                      accountType={accountResolution?.account.account_type}
                      onLinkDetected={handleLinkDetected}
                    />
                  ),
                );
              })()}

          {/* Loading indicator under the latest message — iMessage-style typing bubble.
              Rendered inside contentRef (and before messagesEndRef) so the ResizeObserver
              on contentRef catches its appearance/height changes, and scrollIntoView on
              messagesEndRef scrolls past it instead of leaving it below the viewport. */}
          {isLoading && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
              className="flex justify-start w-full max-w-6xl mx-auto px-4 mb-20"
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

  return (
    <TooltipProvider>
      <div className={cn("flex flex-col h-full bg-background", className)}>
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border/30 bg-muted shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleBackToProject}
            className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
            title="Back to project sessions list"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Project
          </Button>
          {projectPath && (
            <span className="text-xs text-muted-foreground/60 font-mono truncate">
              {projectPath.replace(/^\/Users\/[^/]+/, '~')}
            </span>
          )}
          {gitBranch && (
            <span
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-foreground/5 text-foreground/60"
              title={`Git branch: ${gitBranch}`}
            >
              <GitBranch className="w-3 h-3" />
              {gitBranch}
            </span>
          )}
          {accountResolution?.account.account_type === 'max' && (
            <div className="ml-auto">
              <Popover
                open={usagePopoverOpen}
                onOpenChange={(open) => {
                  setUsagePopoverOpen(open);
                  if (open && !usageText) {
                    setUsageLoading(true);
                    api.getCliUsage(accountResolution.account.config_dir)
                      .then(setUsageText)
                      .catch(() => setUsageText('Failed to load usage'))
                      .finally(() => setUsageLoading(false));
                  }
                }}
                align="end"
                side="bottom"
                className="w-80"
                trigger={
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
                    title="Account usage"
                  >
                    <BarChart3 className="h-3.5 w-3.5" />
                    Usage
                  </Button>
                }
                content={
                  <div className="text-sm">
                    {usageLoading ? (
                      <p className="text-muted-foreground">Loading...</p>
                    ) : (
                      <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed">
                        {usageText}
                      </pre>
                    )}
                  </div>
                }
              />
            </div>
          )}
        </div>
        <SessionHeader
          accountName={accountResolution?.account.name ?? ''}
          accountType={accountResolution?.account.account_type ?? ''}
          configDir={accountResolution?.account.config_dir ?? ''}
          matchType={accountResolution?.match_type ?? ''}
          matchDetail={accountResolution?.match_detail ?? ''}
          sessionId={claudeSessionId}
          cost={sessionCost}
          totalTokens={totalTokens}
          model={selectedModel}
          sdkAccount={sdkAccountInfo}
          contextUsage={contextUsage}
          effortLevel={effort}
          thinkingConfig={thinkingConfig}
          permissionMode={permissionMode}
          sessionStatus={
            sessionStarted
              ? persistentSessionRef.current ? 'active' : 'ended'
              : undefined
          }
          viewModeControl={<SessionViewToggle mode={viewMode} onChange={setViewMode} />}
          className="mb-2"
        />
        {!sessionStarted && (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="border border-border/50 rounded-lg p-6 bg-background/80 w-full max-w-md space-y-4">
              <h3 className="text-base font-medium">New Session</h3>

              {/* Account info */}
              {accountResolution && (
                <div className="space-y-1 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground/40 w-24 shrink-0">Account:</span>
                    <AccountBadge name={accountResolution.account.name} />
                    <span className="text-foreground/50 text-xs">({accountResolution.account.account_type})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-foreground/40 w-24 shrink-0">Config:</span>
                    <span className="font-mono text-xs text-foreground/50 truncate">{accountResolution.account.config_dir}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-foreground/40 w-24 shrink-0">Matched by:</span>
                    <span className="text-xs text-foreground/60">
                      {accountResolution.match_type === 'path_rule' ? 'Path rule' : accountResolution.match_type === 'project_override' ? 'Project override' : 'Default account'}
                      {' — '}{accountResolution.match_detail}
                    </span>
                  </div>
                </div>
              )}

              {/* Model selector */}
              <div className="space-y-1">
                <Label className="text-xs text-foreground/60">Model</Label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={selectedModel === "opus[1m]" ? "default" : "outline"}
                    onClick={() => setSelectedModel("opus[1m]")}
                    className="flex-1"
                  >
                    Opus 1M
                  </Button>
                  <Button
                    size="sm"
                    variant={selectedModel === "opus" ? "default" : "outline"}
                    onClick={() => setSelectedModel("opus")}
                    className="flex-1"
                  >
                    Opus
                  </Button>
                  <Button
                    size="sm"
                    variant={selectedModel === "sonnet" ? "default" : "outline"}
                    onClick={() => setSelectedModel("sonnet")}
                    className="flex-1"
                  >
                    Sonnet
                  </Button>
                </div>
              </div>

              {/* Effort level — maps to the SDK's reasoning_effort parameter.
                  Pre-session pick threads through to startSession so the
                  first prompt uses the chosen effort level. */}
              <div className="space-y-1">
                <Label className="text-xs text-foreground/60">Effort</Label>
                <div className="grid grid-cols-5 gap-1">
                  {EFFORT_LEVELS.map((level) => (
                    <Button
                      key={level.id}
                      size="sm"
                      variant={effort === level.id ? "default" : "outline"}
                      onClick={() => setEffort(level.id)}
                      className="flex-col gap-0.5 h-auto py-2 px-1"
                      title={level.description}
                    >
                      <span className={cn("text-xs font-bold", level.color)}>
                        {level.shortName}
                      </span>
                      <span className="text-[9px] leading-tight">{level.name}</span>
                    </Button>
                  ))}
                </div>
                <p className="text-[10px] text-foreground/40">
                  {EFFORT_LEVELS.find((e) => e.id === effort)?.description}
                </p>
              </div>

              {/* Permission mode (pre-session). Full four-option set,
                  matching the in-session FloatingPromptInput picker so
                  the user never has to re-learn the layout. Defaults to
                  "Auto Accept" per user preference. */}
              <div className="space-y-1">
                <Label className="text-xs text-foreground/60">Permissions</Label>
                <div className="grid grid-cols-2 gap-2">
                  {PERMISSION_MODES.map((mode) => (
                    <Button
                      key={mode.id}
                      size="sm"
                      variant={permissionMode === mode.id ? "default" : "outline"}
                      onClick={() => setPermissionMode(mode.id)}
                      className={cn(
                        "justify-start gap-2",
                        permissionMode !== mode.id && mode.color,
                      )}
                      title={mode.description}
                    >
                      {mode.icon}
                      <span className="text-xs">{mode.name}</span>
                    </Button>
                  ))}
                </div>
                <p className="text-[10px] text-foreground/40">
                  {PERMISSION_MODES.find((m) => m.id === permissionMode)?.description}
                </p>
              </div>

              {/* Auto-allow toggle — only shown in default (Ask) permission mode */}
              {permissionMode === "default" && (
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-xs text-foreground/60">Auto-Allow Tools</Label>
                    <p className="text-[10px] text-foreground/40">
                      {autoAllowEnabled
                        ? "\"Always Allow\" option shown on permission prompts"
                        : "Every tool use requires explicit approval"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={autoAllowEnabled ? "default" : "outline"}
                    onClick={() => {
                      setAutoAllowEnabled(prev => {
                        if (prev) setAutoAllowedTools(new Set());
                        return !prev;
                      });
                    }}
                    className="text-xs"
                  >
                    {autoAllowEnabled ? "On" : "Off"}
                  </Button>
                </div>
              )}

              <Button
                className="w-full"
                onClick={() => {
                  setSessionStarted(true);
                  startPersistentSession();
                }}
              >
                Start Session
              </Button>
            </div>
          </div>
        )}
        <div className="flex-1 min-h-0 w-full flex flex-col relative">

        {/* Main Content Area */}
        <div className={cn(
          "flex-1 min-h-0 overflow-hidden transition-all duration-300 relative",
          (showTimeline || showMCPPanel || showPermissionsPanel) && "sm:mr-96"
        )}>
          {showPreview ? (
            // Split pane layout when preview is active
            <SplitPane
              left={
                <div className="h-full flex flex-col">
                  {messagesList}
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
              {messagesList}
              
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
                            {queuedPrompt.model === "opus[1m]" ? "Opus (1M)" : queuedPrompt.model === "opus" ? "Opus" : "Sonnet"}
                          </span>
                        </div>
                        <p className="text-sm line-clamp-2 break-words">{queuedPrompt.prompt}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <motion.div
                          whileTap={{ scale: 0.97 }}
                          transition={{ duration: 0.15 }}
                        >
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 flex-shrink-0 text-primary hover:text-primary"
                            title="Send now"
                            onClick={() => {
                              // Remove from queue and send immediately
                              setQueuedPrompts(prev => prev.filter(p => p.id !== queuedPrompt.id));
                              // Force reset loading state so handleSendPrompt doesn't re-queue
                              setIsLoading(false);
                              persistentSessionRef.current = false;
                              setTimeout(() => {
                                handleSendPrompt(queuedPrompt.prompt, queuedPrompt.model);
                              }, 50);
                            }}
                          >
                            <Send className="h-3 w-3" />
                          </Button>
                        </motion.div>
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
                      </div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Navigation Arrows */}
          {sessionStarted && displayableMessages.length > 5 && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ delay: 0.5 }}
              className="absolute bottom-4 right-6 z-50"
            >
              <div className="flex items-center bg-background/95 backdrop-blur-md border rounded-full shadow-lg overflow-hidden">
                <TooltipSimple content="Scroll to top" side="top">
                  <motion.div
                    whileTap={{ scale: 0.97 }}
                    transition={{ duration: 0.15 }}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                      // Use virtualizer to scroll to the first item
                      if (displayableMessages.length > 0) {
                        // Scroll to top of the container
                        parentRef.current?.scrollTo({
                          top: 0,
                          behavior: 'smooth'
                        });
                        
                        // After smooth scroll completes, trigger a small scroll to ensure rendering
                        setTimeout(() => {
                          if (parentRef.current) {
                            // Scroll down 1px then back to 0 to trigger virtualizer update
                            parentRef.current.scrollTop = 1;
                            requestAnimationFrame(() => {
                              if (parentRef.current) {
                                parentRef.current.scrollTop = 0;
                              }
                            });
                          }
                        }, 500); // Wait for smooth scroll to complete
                      }
                    }}
                      className="px-3 py-2 hover:bg-accent rounded-none"
                    >
                      <ChevronUp className="h-4 w-4" />
                    </Button>
                  </motion.div>
                </TooltipSimple>
                <div className="w-px h-4 bg-border" />
                <TooltipSimple content="Scroll to bottom" side="top">
                  <motion.div
                    whileTap={{ scale: 0.97 }}
                    transition={{ duration: 0.15 }}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
                      }}
                      className="px-3 py-2 hover:bg-accent rounded-none"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </motion.div>
                </TooltipSimple>
              </div>
            </motion.div>
          )}
        </div>

        {/* Floating Prompt Input - Only after session started */}
        {sessionStarted && <ErrorBoundary>
          <PermissionDialog
            open={waitingForPermission && !!pendingToolUse && !!pendingRequestId}
            toolName={pendingToolUse?.name ?? ''}
            toolInput={pendingToolUse?.input ?? {}}
            title={pendingToolUse?.title}
            displayName={pendingToolUse?.displayName}
            description={pendingToolUse?.description}
            decisionReason={pendingToolUse?.decisionReason}
            suggestions={pendingToolUse?.suggestions ?? []}
            onAllow={(selectedSuggestions) => {
              handlePermissionAllow(tabIdRef.current, selectedSuggestions);
            }}
            onDeny={() => {
              handlePermissionDeny(tabIdRef.current);
            }}
          />

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
            (showTimeline || showMCPPanel || showPermissionsPanel) && "sm:mr-96"
          )}>
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
              extraMenuItems={
                <>
                  {effectiveSession && (
                    <TooltipSimple content="Session Timeline" side="top">
                      <motion.div
                        whileTap={{ scale: 0.97 }}
                        transition={{ duration: 0.15 }}
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => { setShowTimeline(!showTimeline); if (!showTimeline) { setShowMCPPanel(false); setShowPermissionsPanel(false); } }}
                          className="h-9 w-9 text-muted-foreground hover:text-foreground"
                        >
                          <GitBranch className={cn("h-3.5 w-3.5", showTimeline && "text-primary")} />
                        </Button>
                      </motion.div>
                    </TooltipSimple>
                  )}
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
                              className="h-9 w-9 text-muted-foreground hover:text-foreground"
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
                        onClick={() => { setShowMCPPanel(!showMCPPanel); if (!showMCPPanel) { setShowTimeline(false); setShowPermissionsPanel(false); } }}
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      >
                        <Plug className={cn("h-3.5 w-3.5", showMCPPanel && "text-primary")} />
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
                        onClick={() => { setShowPermissionsPanel(!showPermissionsPanel); if (!showPermissionsPanel) { setShowTimeline(false); setShowMCPPanel(false); } }}
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      >
                        <Shield className={cn("h-3.5 w-3.5", showPermissionsPanel && "text-primary")} />
                      </Button>
                    </motion.div>
                  </TooltipSimple>
                  <TooltipSimple content="Checkpoint Settings" side="top">
                    <motion.div
                      whileTap={{ scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setShowSettings(!showSettings)}
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      >
                        <Wrench className={cn("h-3.5 w-3.5", showSettings && "text-primary")} />
                      </Button>
                    </motion.div>
                  </TooltipSimple>
                </>
              }
            />
          </div>

        </ErrorBoundary>}

        {/* Timeline */}
        <AnimatePresence>
          {showTimeline && effectiveSession && (
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="fixed right-0 top-0 h-full w-full sm:w-96 bg-background border-l border-border shadow-xl z-30 overflow-hidden"
            >
              <div className="h-full flex flex-col">
                {/* Timeline Header */}
                <div className="flex items-center justify-between p-4 border-b border-border">
                  <h3 className="text-lg font-semibold">Session Timeline</h3>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setShowTimeline(false)}
                    className="h-8 w-8"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                
                {/* Timeline Content */}
                <div className="flex-1 overflow-y-auto p-4">
                  <TimelineNavigator
                    sessionId={effectiveSession.id}
                    projectId={effectiveSession.project_id}
                    projectPath={projectPath}
                    currentMessageIndex={messages.length - 1}
                    onCheckpointSelect={handleCheckpointSelect}
                    onFork={handleFork}
                    onCheckpointCreated={handleCheckpointCreated}
                    refreshVersion={timelineVersion}
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

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

      {/* Fork Dialog */}
      <Dialog open={showForkDialog} onOpenChange={setShowForkDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Fork Session</DialogTitle>
            <DialogDescription>
              Create a new session branch from the selected checkpoint.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="fork-name">New Session Name</Label>
              <Input
                id="fork-name"
                placeholder="e.g., Alternative approach"
                value={forkSessionName}
                onChange={(e) => setForkSessionName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isLoading) {
                    if (e.nativeEvent.isComposing || isIMEComposingRef.current) {
                      return;
                    }
                    handleConfirmFork();
                  }
                }}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowForkDialog(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmFork}
              disabled={isLoading || !forkSessionName.trim()}
            >
              Create Fork
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings Dialog */}
      {showSettings && effectiveSession && (
        <Dialog open={showSettings} onOpenChange={setShowSettings}>
          <DialogContent className="max-w-2xl">
            <CheckpointSettings
              sessionId={effectiveSession.id}
              projectId={effectiveSession.project_id}
              projectPath={projectPath}
              onClose={() => setShowSettings(false)}
            />
          </DialogContent>
        </Dialog>
      )}

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
