import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import type { ClaudeStreamMessage } from "@/types/claudeStream";

/** How long to wait for a first response before checking health. */
export const RESPONSE_TIMEOUT_MS = 30_000;

/** How long between stream messages before considering the session hung. */
export const INACTIVITY_TIMEOUT_MS = 15_000;

interface UseSessionTimeoutsArgs {
  isLoading: boolean;
  messages: ClaudeStreamMessage[];
  tabId: string;
  waitingForPermission: boolean;
  persistentSessionRef: React.MutableRefObject<boolean>;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setMessages: React.Dispatch<React.SetStateAction<ClaudeStreamMessage[]>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}

interface UseSessionTimeoutsReturn {
  elapsedSeconds: number;
  timedOutMessageIndex: number | null;
  setTimedOutMessageIndex: React.Dispatch<React.SetStateAction<number | null>>;
  lastMessageTimeRef: React.MutableRefObject<number>;
}

export function useSessionTimeouts({
  isLoading,
  messages,
  tabId,
  waitingForPermission,
  persistentSessionRef,
  setIsLoading,
  setMessages,
  setError,
}: UseSessionTimeoutsArgs): UseSessionTimeoutsReturn {
  const [_loadingStartTime, setLoadingStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [timedOutMessageIndex, setTimedOutMessageIndex] = useState<number | null>(null);
  const lastMessageTimeRef = useRef<number>(Date.now());

  // Track elapsed time while loading + response timeout
  useEffect(() => {
    if (isLoading) {
      setLoadingStartTime(Date.now());
      setElapsedSeconds(0);
      const interval = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
      const timeout = setTimeout(async () => {
        // Check if the main process session is still alive before killing
        try {
          const health = await api.sessionGetHealth(tabId);
          if (health.alive && health.status !== "error") {
            // Session is alive — show warning but don't kill it
            setMessages((prev) => [
              ...prev,
              {
                type: "system" as const,
                subtype: "notification",
                notification_type: "warn",
                title: "Slow Response",
                message:
                  "Session is still active but no response yet. Waiting...",
              } as any,
            ]);
            return;
          }
        } catch {
          /* health check failed — treat as dead */
        }

        // Session is dead or errored — reset
        const lastUserIdx = [...messages]
          .reverse()
          .findIndex((m) => m.type === "user" && !m.isMeta);
        if (lastUserIdx !== -1) {
          setTimedOutMessageIndex(messages.length - 1 - lastUserIdx);
        }
        setIsLoading(false);
        setError(null);
        persistentSessionRef.current = false;
      }, RESPONSE_TIMEOUT_MS);
      return () => {
        clearInterval(interval);
        clearTimeout(timeout);
      };
    } else {
      setLoadingStartTime(null);
      setElapsedSeconds(0);
    }
  }, [isLoading, messages.length]);

  // Inactivity detection — if loading and no stream messages for 15s, the session
  // may be hung. Reset so the next prompt auto-restarts the session.
  useEffect(() => {
    if (!isLoading) return;
    const check = setInterval(async () => {
      const idle = Date.now() - lastMessageTimeRef.current;
      if (idle >= INACTIVITY_TIMEOUT_MS && !waitingForPermission) {
        // Check health before killing
        try {
          const health = await api.sessionGetHealth(tabId);
          if (health.alive && health.status !== "error") {
            // Session is alive — show warning but keep waiting
            setMessages((prev) => {
              // Don't spam warnings
              const lastMsg = prev[prev.length - 1];
              if (lastMsg?.title === "Session May Be Unresponsive") return prev;
              return [
                ...prev,
                {
                  type: "system" as const,
                  subtype: "notification",
                  notification_type: "warn",
                  title: "Session May Be Unresponsive",
                  message:
                    "No messages received recently, but session is still alive.",
                } as any,
              ];
            });
            return;
          }
        } catch {
          /* health check failed — treat as dead */
        }

        // Session is dead — reset
        setIsLoading(false);
        persistentSessionRef.current = false;
        setMessages((prev) => [
          ...prev,
          {
            type: "system" as const,
            subtype: "notification",
            notification_type: "warn",
            title: "Session Lost",
            message: "Session is no longer active. Send a message to restart.",
          } as any,
        ]);
      }
    }, 3000);
    return () => clearInterval(check);
  }, [isLoading, waitingForPermission]);

  return {
    elapsedSeconds,
    timedOutMessageIndex,
    setTimedOutMessageIndex,
    lastMessageTimeRef,
  };
}
