import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { fireAndLog } from "@/lib/fireAndLog";
import type { JsonlNode } from "@/types/jsonl";

export const RESPONSE_TIMEOUT_MS = 30_000;

export const INACTIVITY_TIMEOUT_MS = 15_000;

interface UseSessionTimeoutsArgs {
  isLoading: boolean;
  messages: JsonlNode[];
  tabId: string;
  waitingForPermission: boolean;
  persistentSessionRef: React.RefObject<boolean>;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setMessages: React.Dispatch<React.SetStateAction<JsonlNode[]>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}

interface UseSessionTimeoutsReturn {
  elapsedSeconds: number;
  timedOutMessageIndex: number | null;
  setTimedOutMessageIndex: React.Dispatch<React.SetStateAction<number | null>>;
  lastMessageTimeRef: React.RefObject<number>;
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
  const [mountedAt] = useState(() => Date.now());
  const lastMessageTimeRef = useRef<number>(mountedAt);

  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  });

  useEffect(() => {
    if (isLoading) {
      setLoadingStartTime(Date.now());
      setElapsedSeconds(0);
      const interval = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
      const timeout = setTimeout(fireAndLog('use-session-timeouts:loading-watchdog', async () => {
        try {
          const health = await api.sessionGetHealth(tabId);
          if (health.alive && health.sessionStatus !== "error") {
            const now = new Date().toISOString();
            setMessages((prev) => [
              ...prev,
              {
                kind: 'system',
                subtype: 'notification',
                sessionId: '',
                receivedAt: now,
                raw: {
                  type: 'system',
                  subtype: 'notification',
                  notification_type: 'warn',
                  title: 'Slow Response',
                  body: 'Session is still active but no response yet. Waiting...',
                },
              } satisfies JsonlNode,
            ]);
            return;
          }
        } catch {
          /* health check failed — treat as dead */
        }

        const currentMessages = messagesRef.current;
        const lastUserIdx = [...currentMessages]
          .reverse()
          .findIndex((m) => m.kind === "user" && !(m.raw as { isMeta?: boolean }).isMeta);
        if (lastUserIdx !== -1) {
          setTimedOutMessageIndex(currentMessages.length - 1 - lastUserIdx);
        }
        setIsLoading(false);
        setError(null);
        persistentSessionRef.current = false;
      }), RESPONSE_TIMEOUT_MS);
      return () => {
        clearInterval(interval);
        clearTimeout(timeout);
      };
    } else {
      setLoadingStartTime(null);
      setElapsedSeconds(0);
    }
  }, [isLoading, messages.length, tabId, setIsLoading, setMessages, setError, persistentSessionRef]);

  useEffect(() => {
    if (!isLoading) return;
    const check = setInterval(fireAndLog('use-session-timeouts:inactivity-watchdog', async () => {
      const idle = Date.now() - lastMessageTimeRef.current;
      if (idle >= INACTIVITY_TIMEOUT_MS && !waitingForPermission) {
        try {
          const health = await api.sessionGetHealth(tabId);
          if (health.alive && health.sessionStatus !== "error") {
            setMessages((prev) => {
              const lastMsg = prev[prev.length - 1];
              const lastTitle =
                lastMsg?.kind === 'system' && lastMsg.subtype === 'notification'
                  ? (lastMsg.raw as { title?: string }).title
                  : undefined;
              if (lastTitle === "Session May Be Unresponsive") return prev;
              const now = new Date().toISOString();
              return [
                ...prev,
                {
                  kind: 'system',
                  subtype: 'notification',
                  sessionId: '',
                  receivedAt: now,
                  raw: {
                    type: 'system',
                    subtype: 'notification',
                    notification_type: 'warn',
                    title: 'Session May Be Unresponsive',
                    body: 'No messages received recently, but session is still alive.',
                  },
                } satisfies JsonlNode,
              ];
            });
            return;
          }
        } catch {
          /* health check failed — treat as dead */
        }

        setIsLoading(false);
        persistentSessionRef.current = false;
        const nowLost = new Date().toISOString();
        setMessages((prev) => [
          ...prev,
          {
            kind: 'system',
            subtype: 'notification',
            sessionId: '',
            receivedAt: nowLost,
            raw: {
              type: 'system',
              subtype: 'notification',
              notification_type: 'warn',
              title: 'Session Lost',
              body: 'Session is no longer active. Send a message to restart.',
            },
          } satisfies JsonlNode,
        ]);
      }
    }), 3000);
    return () => { clearInterval(check); };
  }, [isLoading, waitingForPermission, tabId, setIsLoading, setMessages, persistentSessionRef]);

  return {
    elapsedSeconds,
    timedOutMessageIndex,
    setTimedOutMessageIndex,
    lastMessageTimeRef,
  };
}
