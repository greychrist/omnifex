import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Copy,
  ChevronDown,
  GitBranch,
  ChevronUp,
  X,
  Hash,
  Wrench
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover } from "@/components/ui/popover";
import { api, type Session } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AccountBadge } from "@/components/AccountBadge";
import { StreamMessage } from "./StreamMessage";
import { FloatingPromptInput, type FloatingPromptInputRef } from "./FloatingPromptInput";
import { ErrorBoundary } from "./ErrorBoundary";
import { TimelineNavigator } from "./TimelineNavigator";
import { CheckpointSettings } from "./CheckpointSettings";
import { SlashCommandsManager } from "./SlashCommandsManager";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { TooltipProvider, TooltipSimple } from "@/components/ui/tooltip-modern";
import { SplitPane } from "@/components/ui/split-pane";
import { WebviewPreview } from "./WebviewPreview";
import type { ClaudeStreamMessage } from "./AgentExecution";
import { PermissionPrompt } from "./PermissionPrompt";
import { SessionHeader } from "./SessionHeader";
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
  const [error, setError] = useState<string | null>(null);
  const [rawJsonlOutput, setRawJsonlOutput] = useState<string[]>([]);
  const [copyPopoverOpen, setCopyPopoverOpen] = useState(false);
  const [totalTokens, setTotalTokens] = useState(0);
  const [extractedSessionInfo, setExtractedSessionInfo] = useState<{ sessionId: string; projectId: string } | null>(null);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [showTimeline, setShowTimeline] = useState(false);
  const [timelineVersion, setTimelineVersion] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showForkDialog, setShowForkDialog] = useState(false);
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
  const [permissionMode, setPermissionMode] = useState<"default" | "skip">("default");
  const [selectedThinking, setSelectedThinking] = useState<"auto" | "concise" | "verbose">("auto");

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

  // Queued prompts state
  const [queuedPrompts, setQueuedPrompts] = useState<Array<{ id: string; prompt: string; model: string }>>([]);
  
  // New state for preview feature
  const [showPreview, setShowPreview] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [showPreviewPrompt, setShowPreviewPrompt] = useState(false);
  const [splitPosition, setSplitPosition] = useState(50);
  const [isPreviewMaximized, setIsPreviewMaximized] = useState(false);
  
  // Add collapsed state for queued prompts
  const [queuedPromptsCollapsed, setQueuedPromptsCollapsed] = useState(false);

  // Permission prompt state
  const [waitingForPermission, setWaitingForPermission] = useState(false);
  const [pendingToolUse, setPendingToolUse] = useState<{ name: string; input: Record<string, any> } | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [autoAllowEnabled, setAutoAllowEnabled] = useState(false);
  const [autoAllowedTools, setAutoAllowedTools] = useState<Set<string>>(new Set());

  const parentRef = useRef<HTMLDivElement>(null);
  const unlistenRefs = useRef<(() => void)[]>([]);
  const persistentSessionRef = useRef(false);
  const tabIdRef = useRef(tabId || 'default');
  const floatingPromptRef = useRef<FloatingPromptInputRef>(null);
  const queuedPromptsRef = useRef<Array<{ id: string; prompt: string; model: string }>>([]);
  const isMountedRef = useRef(true);
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
    queuedPromptsRef.current = queuedPrompts;
  }, [queuedPrompts]);
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
  const displayableMessages = useMemo(() => {
    return messages.filter((message, index) => {
      // Skip meta messages that don't have meaningful content
      if (message.isMeta && !message.leafUuid && !message.summary) {
        return false;
      }

      // Skip user messages that only contain tool results that are already displayed
      if (message.type === "user" && message.message) {
        if (message.isMeta) return false;

        const msg = message.message;
        if (!msg.content || (Array.isArray(msg.content) && msg.content.length === 0)) {
          return false;
        }

        if (Array.isArray(msg.content)) {
          let hasVisibleContent = false;
          for (const content of msg.content) {
            if (content.type === "text") {
              hasVisibleContent = true;
              break;
            }
            if (content.type === "tool_result") {
              let willBeSkipped = false;
              if (content.tool_use_id) {
                // Look for the matching tool_use in previous assistant messages
                for (let i = index - 1; i >= 0; i--) {
                  const prevMsg = messages[i];
                  if (prevMsg.type === 'assistant' && prevMsg.message?.content && Array.isArray(prevMsg.message.content)) {
                    const toolUse = prevMsg.message.content.find((c: any) => 
                      c.type === 'tool_use' && c.id === content.tool_use_id
                    );
                    if (toolUse) {
                      const toolName = toolUse.name?.toLowerCase();
                      const toolsWithWidgets = [
                        'task', 'edit', 'multiedit', 'todowrite', 'ls', 'read', 
                        'glob', 'bash', 'write', 'grep'
                      ];
                      if (toolsWithWidgets.includes(toolName) || toolUse.name?.startsWith('mcp__')) {
                        willBeSkipped = true;
                      }
                      break;
                    }
                  }
                }
              }
              if (!willBeSkipped) {
                hasVisibleContent = true;
                break;
              }
            }
          }
          if (!hasVisibleContent) {
            return false;
          }
        }
      }
      return true;
    });
  }, [messages]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Debug logging
  useEffect(() => {
    console.log('[ClaudeCodeSession] State update:', {
      projectPath,
      session,
      extractedSessionInfo,
      effectiveSession,
      messagesCount: messages.length,
      isLoading
    });
  }, [projectPath, session, extractedSessionInfo, effectiveSession, messages.length, isLoading]);

  // Load session history if resuming
  useEffect(() => {
    if (session) {
      // Set the claudeSessionId immediately when we have a session
      setClaudeSessionId(session.id);

      loadSessionHistory();
    }
  }, [session]);

  // Report streaming state changes
  useEffect(() => {
    onStreamingChange?.(isLoading, claudeSessionId);
  }, [isLoading, claudeSessionId, onStreamingChange]);

  // Auto-scroll to bottom when new messages arrive, but only if already near the bottom
  useEffect(() => {
    if (displayableMessages.length > 0 && isNearBottomRef.current) {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      });
    }
  }, [displayableMessages.length]);

  // Calculate total tokens from messages
  useEffect(() => {
    const tokens = messages.reduce((total, msg) => {
      if (msg.message?.usage) {
        return total + msg.message.usage.input_tokens + msg.message.usage.output_tokens;
      }
      if (msg.usage) {
        return total + msg.usage.input_tokens + msg.usage.output_tokens;
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
      
      setMessages(loadedMessages);
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

  // Filter out noisy stderr messages that aren't real errors
  const isIgnorableStderr = (msg: string) => {
    if (!msg) return false;
    return msg.includes("no stdin data received in") ||
           msg.includes("proceeding without it");
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

      console.log('[ClaudeCodeSession] handleStreamMessage - message type:', message.type);

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

      // Detect permission request from --permission-prompt-tool stdio
      if (message.type === 'permission_request' && message.request_id) {
        const toolName = message.tool_name || 'Unknown';
        const toolInput = message.tool_input || {};
        if (autoAllowEnabled && autoAllowedTools.has(toolName)) {
          const tid = tabIdRef.current;
          api.respondPermission(tid, message.request_id, 'allow').catch(console.error);
        } else {
          setPendingToolUse({ name: toolName, input: toolInput });
          setPendingRequestId(message.request_id);
          setWaitingForPermission(true);
        }
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
      }

      // system:init: skip duplicates, insert before the first user message
      if (message.type === 'system' && message.subtype === 'init') {
        const alreadyHasInit = messagesRef.current.some(
          (m) => m.type === 'system' && m.subtype === 'init'
        );
        if (alreadyHasInit) {
          console.log('[ClaudeCodeSession] Skipping duplicate system:init');
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
        setIsLoading(false);
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

  // Start a persistent stream-json session, setting up listeners ONCE
  const startPersistentSession = async (resumeId?: string) => {
    if (persistentSessionRef.current) return; // Already running

    const tid = tabIdRef.current;

    // Clean up any old listeners
    unlistenRefs.current.forEach(u => u());
    unlistenRefs.current = [];

    // Set up listeners ONCE — scoped to tab_id
    const outputUnlisten = window.electronAPI.onEvent(`claude-output:${tid}`, (payload: any) => {
      handleStreamMessage(payload);
    });

    const errorUnlisten = window.electronAPI.onEvent(`claude-error:${tid}`, (payload: any) => {
      if (isIgnorableStderr(payload)) return;
      console.error('[ClaudeCodeSession] stderr:', payload);
    });

    const completeUnlisten = window.electronAPI.onEvent(`claude-complete:${tid}`, () => {
      console.log('[ClaudeCodeSession] Process exited');
      if (isMountedRef.current) {
        setIsLoading(false);
        persistentSessionRef.current = false;

      }
    });

    unlistenRefs.current = [outputUnlisten, errorUnlisten, completeUnlisten];

    // Start the persistent process
    const mode = permissionMode === "skip" ? "bypassPermissions" : "default";
    await api.startSession(tid, projectPath, selectedModel, mode, resumeId);
    persistentSessionRef.current = true;
  };

  const handleSendPrompt = async (prompt: string, model: string) => {
    console.log('[ClaudeCodeSession] handleSendPrompt called with:', { prompt, model, projectPath, claudeSessionId, effectiveSession });

    if (!projectPath) {
      setError("Please select a project directory first");
      return;
    }

    // If already loading, queue the prompt
    if (isLoading) {
      const newPrompt = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        prompt,
        model
      };
      setQueuedPrompts(prev => [...prev, newPrompt]);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const tid = tabIdRef.current;

      // Model change requires restart
      if (persistentSessionRef.current && model !== selectedModel) {
        await api.stopSession(tid);
        persistentSessionRef.current = false;
        unlistenRefs.current.forEach(u => u());
        unlistenRefs.current = [];
        setSelectedModel(model);
      }

      // Start session if not running
      if (!persistentSessionRef.current) {
        const resumeId = effectiveSession?.id || claudeSessionId || undefined;
        setSelectedModel(model);
        await startPersistentSession(resumeId);
      }

      // Add user message immediately
      const userMessage: ClaudeStreamMessage = {
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: prompt
            }
          ]
        }
      };
      setMessages((prev) => [...prev, userMessage]);

      // Update session metrics
      sessionMetrics.current.promptsSent += 1;
      sessionMetrics.current.lastActivityTime = Date.now();
      if (!sessionMetrics.current.firstMessageTime) {
        sessionMetrics.current.firstMessageTime = Date.now();
      }

      // Track model changes
      const lastModel = sessionMetrics.current.modelChanges.length > 0
        ? sessionMetrics.current.modelChanges[sessionMetrics.current.modelChanges.length - 1].to
        : (sessionMetrics.current.wasResumed ? 'sonnet' : model);

      if (lastModel !== model) {
        sessionMetrics.current.modelChanges.push({
          from: lastModel,
          to: model,
          timestamp: Date.now()
        });
      }

      // Send the message via stdin to the persistent process
      await api.sendMessage(tid, prompt);
    } catch (err) {
      console.error("Failed to send prompt:", err);
      setError(String(err) || "Failed to send prompt");
      setIsLoading(false);
    }
  };

  const handleCopyAsJsonl = async () => {
    const jsonl = rawJsonlOutput.join('\n');
    await navigator.clipboard.writeText(jsonl);
    setCopyPopoverOpen(false);
  };

  const handleCopyAsMarkdown = async () => {
    let markdown = `# Claude Code Session\n\n`;
    markdown += `**Project:** ${projectPath}\n`;
    markdown += `**Date:** ${new Date().toISOString()}\n\n`;
    markdown += `---\n\n`;

    for (const msg of messages) {
      if (msg.type === "system" && msg.subtype === "init") {
        markdown += `## System Initialization\n\n`;
        markdown += `- Session ID: \`${msg.session_id || 'N/A'}\`\n`;
        markdown += `- Model: \`${msg.model || 'default'}\`\n`;
        if (msg.cwd) markdown += `- Working Directory: \`${msg.cwd}\`\n`;
        if (msg.tools?.length) markdown += `- Tools: ${msg.tools.join(', ')}\n`;
        markdown += `\n`;
      } else if (msg.type === "assistant" && msg.message) {
        markdown += `## Assistant\n\n`;
        for (const content of msg.message.content || []) {
          if (content.type === "text") {
            const textContent = typeof content.text === 'string' 
              ? content.text 
              : (content.text?.text || JSON.stringify(content.text || content));
            markdown += `${textContent}\n\n`;
          } else if (content.type === "tool_use") {
            markdown += `### Tool: ${content.name}\n\n`;
            markdown += `\`\`\`json\n${JSON.stringify(content.input, null, 2)}\n\`\`\`\n\n`;
          }
        }
        if (msg.message.usage) {
          markdown += `*Tokens: ${msg.message.usage.input_tokens} in, ${msg.message.usage.output_tokens} out*\n\n`;
        }
      } else if (msg.type === "user" && msg.message) {
        markdown += `## User\n\n`;
        for (const content of msg.message.content || []) {
          if (content.type === "text") {
            const textContent = typeof content.text === 'string' 
              ? content.text 
              : (content.text?.text || JSON.stringify(content.text));
            markdown += `${textContent}\n\n`;
          } else if (content.type === "tool_result") {
            markdown += `### Tool Result\n\n`;
            let contentText = '';
            if (typeof content.content === 'string') {
              contentText = content.content;
            } else if (content.content && typeof content.content === 'object') {
              if (content.content.text) {
                contentText = content.content.text;
              } else if (Array.isArray(content.content)) {
                contentText = content.content
                  .map((c: any) => (typeof c === 'string' ? c : c.text || JSON.stringify(c)))
                  .join('\n');
              } else {
                contentText = JSON.stringify(content.content, null, 2);
              }
            }
            markdown += `\`\`\`\n${contentText}\n\`\`\`\n\n`;
          }
        }
      } else if (msg.type === "result") {
        markdown += `## Execution Result\n\n`;
        if (msg.result) {
          markdown += `${msg.result}\n\n`;
        }
        if (msg.error) {
          markdown += `**Error:** ${msg.error}\n\n`;
        }
      }
    }

    await navigator.clipboard.writeText(markdown);
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

  const handleCancelExecution = async () => {
    if (!isLoading) return;

    const tid = tabIdRef.current;

    try {
      await api.stopSession(tid);

      // Clean up listeners
      unlistenRefs.current.forEach(unlisten => unlisten());
      unlistenRefs.current = [];

      // Reset states
      setIsLoading(false);
      persistentSessionRef.current = false;
      setError(null);

      // Clear queued prompts
      setQueuedPrompts([]);

      // Add a message indicating the session was cancelled
      const cancelMessage: ClaudeStreamMessage = {
        type: "system",
        subtype: "info",
        result: "Session cancelled by user",
        timestamp: new Date().toISOString()
      };
      setMessages(prev => [...prev, cancelMessage]);
    } catch (err) {
      console.error("Failed to cancel execution:", err);

      const errorMessage: ClaudeStreamMessage = {
        type: "system",
        subtype: "error",
        result: `Failed to cancel execution: ${err instanceof Error ? err.message : 'Unknown error'}. The process may still be running in the background.`,
        timestamp: new Date().toISOString()
      };
      setMessages(prev => [...prev, errorMessage]);

      // Clean up listeners anyway
      unlistenRefs.current.forEach(unlisten => unlisten());
      unlistenRefs.current = [];

      // Reset states to allow user to continue
      setIsLoading(false);
      persistentSessionRef.current = false;
      setError(null);
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
    console.log('[ClaudeCodeSession] Preview URL changed to:', url);
    setPreviewUrl(url);
  };

  const handleTogglePreviewMaximize = () => {
    setIsPreviewMaximized(!isPreviewMaximized);
    // Reset split position when toggling maximize
    if (isPreviewMaximized) {
      setSplitPosition(50);
    }
  };

  // Cleanup event listeners and track mount state
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      console.log('[ClaudeCodeSession] Component unmounting, cleaning up');
      isMountedRef.current = false;

      // Stop the persistent process if the tab is being closed mid-session
      const tid = tabIdRef.current;
      if (tid && persistentSessionRef.current) {
        console.log('[ClaudeCodeSession] Stopping persistent session on unmount:', tid);
        api.stopSession(tid).catch(err => {
          console.error("Failed to stop session on unmount:", err);
        });
      }

      // Clean up listeners
      unlistenRefs.current.forEach(unlisten => unlisten());
      unlistenRefs.current = [];

      // Clear checkpoint manager when session ends
      if (effectiveSession) {
        api.clearCheckpointManager(effectiveSession.id).catch(err => {
          console.error("Failed to clear checkpoint manager:", err);
        });
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- cleanup must only run on unmount

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    // Consider "near bottom" if within 150px of the bottom
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
  }, []);

  const messagesList = (
    <div
      ref={parentRef}
      className="flex-1 overflow-y-auto relative pb-20"
      onScroll={handleScroll}
      style={{
        contain: 'strict',
      }}
    >
      <div className="w-full max-w-6xl mx-auto px-4 pt-8 pb-4 space-y-4">
          {displayableMessages.map((message, idx) => (
            <div key={idx}>
              <StreamMessage
                message={message}
                streamMessages={messages}
                onLinkDetected={handleLinkDetected}
              />
            </div>
          ))}
          <div ref={messagesEndRef} />
      </div>

      {/* Loading indicator under the latest message */}
      {isLoading && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          className="flex items-center justify-center py-4 mb-20"
        >
          <div className="rotating-symbol text-primary" />
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

  return (
    <TooltipProvider>
      <div className={cn("flex flex-col h-full bg-background", className)}>
        {accountResolution && (
          <SessionHeader
            accountName={accountResolution.account.name}
            accountType={accountResolution.account.account_type}
            configDir={accountResolution.account.config_dir}
            matchType={accountResolution.match_type}
            matchDetail={accountResolution.match_detail}
            sessionId={claudeSessionId}
            cost={sessionCost}
            totalTokens={totalTokens}
            model={selectedModel}
            className="mb-2"
          />
        )}
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

              {/* Thinking mode */}
              <div className="space-y-1">
                <Label className="text-xs text-foreground/60">Thinking</Label>
                <div className="flex gap-2">
                  {(["auto", "concise", "verbose"] as const).map((mode) => (
                    <Button
                      key={mode}
                      size="sm"
                      variant={selectedThinking === mode ? "default" : "outline"}
                      onClick={() => setSelectedThinking(mode)}
                      className="flex-1 capitalize"
                    >
                      {mode}
                    </Button>
                  ))}
                </div>
              </div>

              {/* Permission mode */}
              <div className="space-y-1">
                <Label className="text-xs text-foreground/60">Permissions</Label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={permissionMode === "default" ? "default" : "outline"}
                    onClick={() => setPermissionMode("default")}
                    className="flex-1"
                  >
                    Ask Each Time
                  </Button>
                  <Button
                    size="sm"
                    variant={permissionMode === "skip" ? "default" : "outline"}
                    onClick={() => setPermissionMode("skip")}
                    className="flex-1"
                  >
                    Auto-Approve
                  </Button>
                </div>
                <p className="text-[10px] text-foreground/40">
                  {permissionMode === "default"
                    ? "Claude will ask before running tools (same as terminal)"
                    : "All tool uses auto-approved (--dangerously-skip-permissions)"}
                </p>
              </div>

              {/* Auto-allow toggle — only shown in default permission mode */}
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
                onClick={() => setSessionStarted(true)}
              >
                Start Session
              </Button>
            </div>
          </div>
        )}
        <div className="w-full h-full flex flex-col">

        {/* Main Content Area */}
        <div className={cn(
          "flex-1 overflow-hidden transition-all duration-300",
          showTimeline && "sm:mr-96"
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
            <div className="h-full flex flex-col max-w-6xl mx-auto px-6">
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
        </div>

        {/* Floating Prompt Input - Only after session started */}
        {sessionStarted && <ErrorBoundary>
          {/* Queued Prompts Display */}
          <AnimatePresence>
            {queuedPrompts.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 20 }}
                className="fixed bottom-24 left-1/2 -translate-x-1/2 z-30 w-full max-w-3xl px-4"
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
                            {queuedPrompt.model === "opus" ? "Opus" : "Sonnet"}
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

          {/* Navigation Arrows - positioned above prompt bar with spacing */}
          {displayableMessages.length > 5 && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ delay: 0.5 }}
              className="fixed bottom-32 right-6 z-50"
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

          {waitingForPermission && pendingToolUse && pendingRequestId && (
            <div className={cn(
              "fixed bottom-6 left-0 right-0 z-[60] px-4",
              showTimeline && "sm:right-96"
            )}>
              <div className="max-w-3xl mx-auto">
                <PermissionPrompt
                  tabId={tabIdRef.current}
                  requestId={pendingRequestId}
                  toolName={pendingToolUse.name}
                  toolInput={pendingToolUse.input}
                  autoAllowEnabled={autoAllowEnabled}
                  autoAllowedTools={autoAllowedTools}
                  onAutoAllow={(tool) => setAutoAllowedTools(prev => new Set([...prev, tool]))}
                  onResponded={() => {
                    setWaitingForPermission(false);
                    setPendingToolUse(null);
                    setPendingRequestId(null);
                  }}
                />
              </div>
            </div>
          )}

          <div className={cn(
            "fixed bottom-0 left-0 right-0 transition-all duration-300 z-50",
            showTimeline && "sm:right-96"
          )}>
            <FloatingPromptInput
              ref={floatingPromptRef}
              onSend={handleSendPrompt}
              onCancel={handleCancelExecution}
              isLoading={isLoading}
              disabled={!projectPath}
              projectPath={projectPath}
              defaultModel={selectedModel}
              permissionMode={permissionMode}
              onPermissionModeChange={setPermissionMode}
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
                          onClick={() => setShowTimeline(!showTimeline)}
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

          {/* Token Counter - positioned under the Send button */}
          {totalTokens > 0 && (
            <div className="fixed bottom-0 left-0 right-0 z-30 pointer-events-none">
              <div className="max-w-6xl mx-auto">
                <div className="flex justify-end px-4 pb-2">
                  <motion.div
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    className="bg-background/95 backdrop-blur-md border rounded-full px-3 py-1 shadow-lg pointer-events-auto"
                  >
                    <div className="flex items-center gap-1.5 text-xs">
                      <Hash className="h-3 w-3 text-muted-foreground" />
                      <span className="font-mono">{totalTokens.toLocaleString()}</span>
                      <span className="text-muted-foreground">tokens</span>
                    </div>
                  </motion.div>
                </div>
              </div>
            </div>
          )}
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
              <SlashCommandsManager projectPath={projectPath} />
            </div>
          </DialogContent>
        </Dialog>
      )}
      </div>
    </TooltipProvider>
  );
};
