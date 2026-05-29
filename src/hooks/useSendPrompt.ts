import { useState, useRef } from "react";
import { api, type Session } from "@/lib/api";
import type { JsonlNode } from "@/types/jsonl";

export interface QueuedPromptItem {
  id: string;
  prompt: string;
  model: string;
  images?: string[];
}

interface UseSendPromptArgs {
  projectPath: string;
  tabId: string;
  /**
   * Live ref to the parent's `isLoading`. Read at call-time so the queue-drain
   * path (which holds onto handleSendPrompt across renders via setTimeout)
   * sees the current value rather than a stale closure capture. Reading from
   * a closure-captured `isLoading` boolean caused the queue to silently
   * re-enqueue drained prompts instead of sending them.
   */
  isLoadingRef: React.MutableRefObject<boolean>;
  selectedModel: string;
  persistentSessionRef: React.MutableRefObject<boolean>;
  unlistenRefs: React.MutableRefObject<(() => void)[]>;
  effectiveSession: Session | null;
  claudeSessionId: string | null;
  sessionMetrics: React.MutableRefObject<{
    promptsSent: number;
    lastActivityTime: number;
    firstMessageTime: number | null;
    modelChanges: { from: string; to: string; timestamp: number }[];
    wasResumed: boolean;
    [key: string]: any;
  }>;
  startPersistentSession: (resumeId?: string) => Promise<void>;
  pickGerund: () => string;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setCurrentActivity: React.Dispatch<React.SetStateAction<string>>;
  setSelectedModel: React.Dispatch<React.SetStateAction<string>>;
  setMessages: React.Dispatch<React.SetStateAction<JsonlNode[]>>;
}

interface UseSendPromptReturn {
  handleSendPrompt: (prompt: string, model: string, images?: string[]) => Promise<void>;
  queuedPrompts: QueuedPromptItem[];
  setQueuedPrompts: React.Dispatch<React.SetStateAction<QueuedPromptItem[]>>;
  queuedPromptsRef: React.MutableRefObject<QueuedPromptItem[]>;
  lastPromptRef: React.MutableRefObject<{ prompt: string; model: string } | null>;
}

export function useSendPrompt({
  projectPath,
  tabId,
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
}: UseSendPromptArgs): UseSendPromptReturn {
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPromptItem[]>([]);
  const queuedPromptsRef = useRef<QueuedPromptItem[]>([]);
  const lastPromptRef = useRef<{ prompt: string; model: string } | null>(null);

  const handleSendPrompt = async (
    prompt: string,
    model: string,
    images?: string[],
  ) => {
    if (!projectPath) {
      setError("Please select a project directory first");
      return;
    }

    // If already loading, queue the prompt. Read from the ref (not a closure
    // boolean) so a stale reference held by the queue-drain setTimeout sees
    // the current loading state, not whatever value was captured at render.
    if (isLoadingRef.current) {
      const newPrompt: QueuedPromptItem = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        prompt,
        model,
        ...(images && images.length > 0 ? { images } : {}),
      };
      setQueuedPrompts((prev) => [...prev, newPrompt]);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      setCurrentActivity(pickGerund());
      lastPromptRef.current = { prompt, model };

      // Mid-session model change: use the CLI's Query.setModel() rather than
      // tearing down and restarting the session.
      if (persistentSessionRef.current && model !== selectedModel) {
        try {
          await api.sessionSetModel(tabId, model);
        } catch (e) {
          console.error(
            "[sessions] sessionSetModel failed, falling back to restart:",
            e,
          );
          await api.stopSession(tabId);
          persistentSessionRef.current = false;
          unlistenRefs.current.forEach((u) => { u(); });
          unlistenRefs.current = [];
        }
        setSelectedModel(model);
      }

      // Start session if not running
      if (!persistentSessionRef.current) {
        const resumeId =
          effectiveSession?.id || claudeSessionId || undefined;
        setSelectedModel(model);
        await startPersistentSession(resumeId);
      }

      // Build content blocks: text + any pasted images
      const contentBlocks: Record<string, unknown>[] = [];
      if (prompt) {
        contentBlocks.push({ type: "text", text: prompt });
      }
      if (images && images.length > 0) {
        const BASE64_MARKER = ';base64,';
        for (const dataUrl of images) {
          const markerIdx = dataUrl.indexOf(BASE64_MARKER);
          if (!dataUrl.startsWith('data:image/') || markerIdx === -1) continue;
          const media_type = dataUrl.slice('data:'.length, markerIdx);
          const data = dataUrl.slice(markerIdx + BASE64_MARKER.length);
          if (!data) continue;
          contentBlocks.push({
            type: "image",
            source: { type: "base64", media_type, data },
          });
        }
      }

      // Add user message immediately for UI display as a JsonlNode.
      // Stamp with receivedAt so StreamMessage renders a card timestamp the
      // same way it does for CLI-forwarded messages.
      const receivedAt = new Date().toISOString();
      const userMessage = {
        kind: 'user',
        userKind: 'prompt',
        sessionId: '',
        receivedAt,
        raw: {
          type: 'user',
          message: { role: 'user', content: contentBlocks },
        },
      } satisfies JsonlNode;
      setMessages((prev) => [...prev, userMessage]);

      // Update session metrics
      sessionMetrics.current.promptsSent += 1;
      sessionMetrics.current.lastActivityTime = Date.now();
      if (!sessionMetrics.current.firstMessageTime) {
        sessionMetrics.current.firstMessageTime = Date.now();
      }

      // Track model changes
      const lastModel =
        sessionMetrics.current.modelChanges.length > 0
          ? sessionMetrics.current.modelChanges[
              sessionMetrics.current.modelChanges.length - 1
            ].to
          : sessionMetrics.current.wasResumed
            ? "sonnet"
            : model;

      if (lastModel !== model) {
        sessionMetrics.current.modelChanges.push({
          from: lastModel,
          to: model,
          timestamp: Date.now(),
        });
      }

      // Send the message via stdin to the persistent process
      if (contentBlocks.some((b) => b.type === 'image')) {
        await api.sendStructuredMessage(tabId, contentBlocks);
      } else {
        await api.sendMessage(tabId, prompt);
      }
    } catch (err) {
      console.error("Failed to send prompt:", err);
      setError(String(err) || "Failed to send prompt");
      setIsLoading(false);
    }
  };

  return {
    handleSendPrompt,
    queuedPrompts,
    setQueuedPrompts,
    queuedPromptsRef,
    lastPromptRef,
  };
}
