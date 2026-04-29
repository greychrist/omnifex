import { useState, useRef } from "react";
import { api, type Session } from "@/lib/api";
import type { ClaudeStreamMessage } from "@/types/claudeStream";

interface UseSendPromptArgs {
  projectPath: string;
  tabId: string;
  isLoading: boolean;
  selectedModel: string;
  persistentSessionRef: React.MutableRefObject<boolean>;
  unlistenRefs: React.MutableRefObject<(() => void)[]>;
  effectiveSession: Session | null;
  claudeSessionId: string | null;
  sessionMetrics: React.MutableRefObject<{
    promptsSent: number;
    lastActivityTime: number;
    firstMessageTime: number | null;
    modelChanges: Array<{ from: string; to: string; timestamp: number }>;
    wasResumed: boolean;
    [key: string]: any;
  }>;
  startPersistentSession: (resumeId?: string) => Promise<void>;
  pickGerund: () => string;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setCurrentActivity: React.Dispatch<React.SetStateAction<string>>;
  setSelectedModel: React.Dispatch<React.SetStateAction<string>>;
  setMessages: React.Dispatch<React.SetStateAction<ClaudeStreamMessage[]>>;
}

interface UseSendPromptReturn {
  handleSendPrompt: (prompt: string, model: string, images?: string[]) => Promise<void>;
  queuedPrompts: Array<{ id: string; prompt: string; model: string }>;
  setQueuedPrompts: React.Dispatch<React.SetStateAction<Array<{ id: string; prompt: string; model: string }>>>;
  queuedPromptsRef: React.MutableRefObject<Array<{ id: string; prompt: string; model: string }>>;
  lastPromptRef: React.MutableRefObject<{ prompt: string; model: string } | null>;
}

export function useSendPrompt({
  projectPath,
  tabId,
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
}: UseSendPromptArgs): UseSendPromptReturn {
  const [queuedPrompts, setQueuedPrompts] = useState<
    Array<{ id: string; prompt: string; model: string }>
  >([]);
  const queuedPromptsRef = useRef<
    Array<{ id: string; prompt: string; model: string }>
  >([]);
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

    // If already loading, queue the prompt
    if (isLoading) {
      const newPrompt = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        prompt,
        model,
      };
      setQueuedPrompts((prev) => [...prev, newPrompt]);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      setCurrentActivity(pickGerund());
      lastPromptRef.current = { prompt, model };

      // Mid-session model change: use the SDK's Query.setModel() rather than
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
          unlistenRefs.current.forEach((u) => u());
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
      const contentBlocks: Array<Record<string, unknown>> = [];
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

      // Add user message immediately for UI display.
      // Stamp with receivedAt so StreamMessage renders a card timestamp the
      // same way it does for SDK-forwarded messages (main-process stamps
      // those in lifecycle.ts#listenToMessages).
      const userMessage: ClaudeStreamMessage = {
        type: "user",
        message: { content: contentBlocks },
        receivedAt: new Date().toISOString(),
      };
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
