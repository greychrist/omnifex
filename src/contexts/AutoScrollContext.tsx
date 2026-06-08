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
  AUTOSCROLL_REENGAGE_SETTING_KEY,
  AUTOSCROLL_DISENGAGE_SETTING_KEY,
  DEFAULT_AUTOSCROLL_REENGAGE_PX,
  DEFAULT_AUTOSCROLL_DISENGAGE_PX,
  clampThresholds,
  parseThresholdPx,
  type AutoScrollThresholds,
} from "@/lib/autoScrollThresholds";

interface AutoScrollContextType extends AutoScrollThresholds {
  /** Persist a new pair (clamped) and apply it live to all transcripts. */
  setThresholds: (next: AutoScrollThresholds) => Promise<void>;
  isLoading: boolean;
}

const AutoScrollContext = createContext<AutoScrollContextType | undefined>(
  undefined,
);

export const AutoScrollProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [reengagePx, setReengagePx] = useState(DEFAULT_AUTOSCROLL_REENGAGE_PX);
  const [disengagePx, setDisengagePx] = useState(
    DEFAULT_AUTOSCROLL_DISENGAGE_PX,
  );
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [reengageRaw, disengageRaw] = await Promise.all([
          api.getSetting(AUTOSCROLL_REENGAGE_SETTING_KEY),
          api.getSetting(AUTOSCROLL_DISENGAGE_SETTING_KEY),
        ]);
        if (cancelled) return;
        const next = clampThresholds({
          reengagePx: parseThresholdPx(
            reengageRaw,
            DEFAULT_AUTOSCROLL_REENGAGE_PX,
          ),
          disengagePx: parseThresholdPx(
            disengageRaw,
            DEFAULT_AUTOSCROLL_DISENGAGE_PX,
          ),
        });
        setReengagePx(next.reengagePx);
        setDisengagePx(next.disengagePx);
      } catch (error) {
        console.error("Failed to load auto-scroll thresholds:", error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    logAndForget("auto-scroll-context:load", load());
    return () => {
      cancelled = true;
    };
  }, []);

  const setThresholds = useCallback(async (next: AutoScrollThresholds) => {
    const clamped = clampThresholds(next);
    setReengagePx(clamped.reengagePx);
    setDisengagePx(clamped.disengagePx);
    try {
      await Promise.all([
        api.saveSetting(
          AUTOSCROLL_REENGAGE_SETTING_KEY,
          String(clamped.reengagePx),
        ),
        api.saveSetting(
          AUTOSCROLL_DISENGAGE_SETTING_KEY,
          String(clamped.disengagePx),
        ),
      ]);
    } catch (error) {
      console.error("Failed to save auto-scroll thresholds:", error);
    }
  }, []);

  return (
    <AutoScrollContext.Provider
      value={{ reengagePx, disengagePx, setThresholds, isLoading }}
    >
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
