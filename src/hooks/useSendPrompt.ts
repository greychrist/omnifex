import { useState, useRef } from "react";
import { api, type Session } from "@/lib/api";
import type { JsonlNode } from "@/types/jsonl";
import { parseBtw } from "@/lib/sideChat";
import { newQueuedPromptId } from "@/lib/sessionStreamEffects";

export interface QueuedPromptItem {
  id: string;
  prompt: string;
  model: string;
  images?: string[];
}

export interface SendPromptOptions {
  /** Queue at the head: it answers something that already happened (a denial card's retry). */
  front?: boolean;
}

interface UseSendPromptArgs {
  projectPath: string;
  tabId: string;
  /** Read at call time: the queue drain holds this callback across renders, and a captured boolean re-enqueued drained prompts. */
  turnRunningRef: React.RefObject<boolean>;
  selectedModel: string;
  persistentSessionRef: React.RefObject<boolean>;
  unlistenRefs: React.RefObject<(() => void)[]>;
  effectiveSession: Session | null;
  claudeSessionId: string | null;
  sessionMetrics: React.RefObject<{
    promptsSent: number;
    lastActivityTime: number;
    firstMessageTime: number | null;
    modelChanges: { from: string; to: string; timestamp: number }[];
    wasResumed: boolean;
    [key: string]: unknown;
  }>;
  startPersistentSession: (resumeId?: string) => Promise<void>;
  pickGerund: () => string;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setCurrentActivity: React.Dispatch<React.SetStateAction<string>>;
  setSelectedModel: React.Dispatch<React.SetStateAction<string>>;
  setMessages: React.Dispatch<React.SetStateAction<JsonlNode[]>>;
  /** Omitted for engines with no side chat (Codex), where `/btw` stays an ordinary prompt. */
  onSideChat?: (question: string) => void;
}

interface UseSendPromptReturn {
  handleSendPrompt: (prompt: string, model: string, images?: string[], opts?: SendPromptOptions) => Promise<void>;
  queuedPrompts: QueuedPromptItem[];
  setQueuedPrompts: React.Dispatch<React.SetStateAction<QueuedPromptItem[]>>;
  queuedPromptsRef: React.RefObject<QueuedPromptItem[]>;
  lastPromptRef: React.RefObject<{ prompt: string; model: string } | null>;
}

export function useSendPrompt({
  projectPath,
  tabId,
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
  onSideChat,
}: UseSendPromptArgs): UseSendPromptReturn {
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPromptItem[]>([]);
  const queuedPromptsRef = useRef<QueuedPromptItem[]>([]);
  const lastPromptRef = useRef<{ prompt: string; model: string } | null>(null);
  // Main opens the turn only once it has the prompt; until then `turnRunningRef` reads idle and this latch
  // must gate a second prompt into the queue.
  const sendingRef = useRef(false);

  const handleSendPrompt = async (
    prompt: string,
    model: string,
    images?: string[],
    opts?: SendPromptOptions,
  ) => {
    if (!projectPath) {
      setError("Please select a project directory first");
      return;
    }

    // Checked ahead of the queue: every entry path comes through here, so none can queue a side question behind a turn.
    const btw = onSideChat ? parseBtw(prompt) : null;
    if (btw !== null) {
      onSideChat?.(btw);
      return;
    }

    if (turnRunningRef.current || sendingRef.current) {
      const newPrompt: QueuedPromptItem = {
        id: newQueuedPromptId(),
        prompt,
        model,
        ...(images && images.length > 0 ? { images } : {}),
      };
      setQueuedPrompts((prev) => (opts?.front ? [newPrompt, ...prev] : [...prev, newPrompt]));
      return;
    }

    sendingRef.current = true;
    try {
      setError(null);
      setCurrentActivity(pickGerund());
      lastPromptRef.current = { prompt, model };

      // Mid-session model change: set it on the live process rather than restarting the session.
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

      if (!persistentSessionRef.current) {
        const resumeId =
          effectiveSession?.id || claudeSessionId || undefined;
        setSelectedModel(model);
        await startPersistentSession(resumeId);
      }

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

      sessionMetrics.current.promptsSent += 1;
      sessionMetrics.current.lastActivityTime = Date.now();
      if (!sessionMetrics.current.firstMessageTime) {
        sessionMetrics.current.firstMessageTime = Date.now();
      }

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

      if (contentBlocks.some((b) => b.type === 'image')) {
        await api.sendStructuredMessage(tabId, contentBlocks);
      } else {
        await api.sendMessage(tabId, prompt);
      }
    } catch (err) {
      console.error("Failed to send prompt:", err);
      setError(String(err) || "Failed to send prompt");
    } finally {
      sendingRef.current = false;
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
