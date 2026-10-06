import React, {
  createContext,
  useState,
  useContext,
  useCallback,
  useEffect,
} from "react";
import { api } from "@/lib/api";
import { logAndForget } from "@/lib/fireAndLog";
import {
  AUTOSCROLL_FOLLOW_SETTING_KEY,
  DEFAULT_AUTOSCROLL_FOLLOW_PX,
  clampFollowPx,
  parseFollowPx,
} from "@/lib/autoScrollFollow";

interface AutoScrollContextType {
  /** Distance from the bottom (px) within which the chat follows new messages. */
  followPx: number;
  /** Persist a new distance (clamped) and apply it live to all transcripts. */
  setFollowPx: (next: number) => Promise<void>;
  isLoading: boolean;
}

const AutoScrollContext = createContext<AutoScrollContextType | undefined>(
  undefined,
);

export const AutoScrollProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [followPx, setFollowPxState] = useState(DEFAULT_AUTOSCROLL_FOLLOW_PX);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const raw = await api.getSetting(AUTOSCROLL_FOLLOW_SETTING_KEY);
        if (cancelled) return;
        setFollowPxState(parseFollowPx(raw));
      } catch (error) {
        console.error("Failed to load auto-scroll distance:", error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    logAndForget("auto-scroll-context:load", load());
    return () => {
      cancelled = true;
    };
  }, []);

  // Rejects when the write fails (the distance still applies), so Settings
  // can report it.
  const setFollowPx = useCallback(async (next: number) => {
    const clamped = clampFollowPx(next);
    setFollowPxState(clamped);
    await api.saveSetting(AUTOSCROLL_FOLLOW_SETTING_KEY, String(clamped));
  }, []);

  return (
    <AutoScrollContext.Provider value={{ followPx, setFollowPx, isLoading }}>
      {children}
    </AutoScrollContext.Provider>
  );
};

export const useAutoScroll = (): AutoScrollContextType => {
  const ctx = useContext(AutoScrollContext);
  if (!ctx) {
    throw new Error("useAutoScroll must be used within an AutoScrollProvider");
  }
  return ctx;
};
