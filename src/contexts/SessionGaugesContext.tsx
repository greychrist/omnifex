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
  CONTEXT_PRESSURE_ENABLED_SETTING_KEY,
  CONTEXT_PRESSURE_MODE_SETTING_KEY,
  CONTEXT_PRESSURE_VALUE_SETTING_KEY,
  DEFAULT_CONTEXT_PRESSURE,
  clampContextPressureValue,
  parseContextPressureEnabled,
  parseContextPressureMode,
  parseContextPressureValue,
  type ContextPressureSetting,
} from "@/lib/contextPressure";
import {
  CACHE_TIMER_ENABLED_SETTING_KEY,
  DEFAULT_CACHE_TIMER_ENABLED,
} from "@/lib/cacheExpiry";
import {
  CONTEXT_JUMP_ENABLED_SETTING_KEY,
  CONTEXT_JUMP_TOKENS_SETTING_KEY,
  DEFAULT_CONTEXT_JUMP,
  clampJumpTokens,
  parseJumpTokens,
  type ContextJumpSetting,
} from "@/lib/turnDelta";

/**
 * The two session-header gauges that are user-configurable: the
 * context-pressure banner's budget, and whether the prompt-cache countdown
 * shows. Both live in one provider because they are one Settings section and
 * one load round-trip; splitting them would mean two near-identical providers
 * and an extra level in the App tree.
 *
 * Same shape as AutoScrollContext: load once on mount, persist on change, and
 * apply live to open sessions without a restart.
 */
interface SessionGaugesContextType {
  contextPressure: ContextPressureSetting;
  setContextPressure: (next: ContextPressureSetting) => Promise<void>;
  cacheTimerEnabled: boolean;
  setCacheTimerEnabled: (next: boolean) => Promise<void>;
  contextJump: ContextJumpSetting;
  setContextJump: (next: ContextJumpSetting) => Promise<void>;
  isLoading: boolean;
}

const SessionGaugesContext = createContext<SessionGaugesContextType | undefined>(
  undefined,
);

export const SessionGaugesProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [contextPressure, setContextPressureState] =
    useState<ContextPressureSetting>(DEFAULT_CONTEXT_PRESSURE);
  const [cacheTimerEnabled, setCacheTimerEnabledState] = useState(
    DEFAULT_CACHE_TIMER_ENABLED,
  );
  const [contextJump, setContextJumpState] =
    useState<ContextJumpSetting>(DEFAULT_CONTEXT_JUMP);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [enabledRaw, modeRaw, valueRaw, cacheRaw, jumpEnabledRaw, jumpTokensRaw] =
          await Promise.all([
            api.getSetting(CONTEXT_PRESSURE_ENABLED_SETTING_KEY),
            api.getSetting(CONTEXT_PRESSURE_MODE_SETTING_KEY),
            api.getSetting(CONTEXT_PRESSURE_VALUE_SETTING_KEY),
            api.getSetting(CACHE_TIMER_ENABLED_SETTING_KEY),
            api.getSetting(CONTEXT_JUMP_ENABLED_SETTING_KEY),
            api.getSetting(CONTEXT_JUMP_TOKENS_SETTING_KEY),
          ]);
        if (cancelled) return;
        const mode = parseContextPressureMode(modeRaw);
        setContextPressureState({
          enabled: parseContextPressureEnabled(enabledRaw),
          mode,
          value: parseContextPressureValue(valueRaw, mode),
        });
        setCacheTimerEnabledState(
          cacheRaw === null ? DEFAULT_CACHE_TIMER_ENABLED : cacheRaw === "true",
        );
        setContextJumpState({
          enabled:
            jumpEnabledRaw === null
              ? DEFAULT_CONTEXT_JUMP.enabled
              : jumpEnabledRaw === "true",
          thresholdTokens: parseJumpTokens(jumpTokensRaw),
        });
      } catch (error) {
        console.error("Failed to load session gauge settings:", error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    logAndForget("session-gauges-context:load", load());
    return () => {
      cancelled = true;
    };
  }, []);

  const setContextPressure = useCallback(async (next: ContextPressureSetting) => {
    const clamped: ContextPressureSetting = {
      ...next,
      value: clampContextPressureValue(next.value, next.mode),
    };
    setContextPressureState(clamped);
    try {
      await Promise.all([
        api.saveSetting(
          CONTEXT_PRESSURE_ENABLED_SETTING_KEY,
          clamped.enabled ? "true" : "false",
        ),
        api.saveSetting(CONTEXT_PRESSURE_MODE_SETTING_KEY, clamped.mode),
        api.saveSetting(
          CONTEXT_PRESSURE_VALUE_SETTING_KEY,
          String(clamped.value),
        ),
      ]);
    } catch (error) {
      console.error("Failed to save context pressure setting:", error);
    }
  }, []);

  const setCacheTimerEnabled = useCallback(async (next: boolean) => {
    setCacheTimerEnabledState(next);
    try {
      await api.saveSetting(
        CACHE_TIMER_ENABLED_SETTING_KEY,
        next ? "true" : "false",
      );
    } catch (error) {
      console.error("Failed to save cache timer setting:", error);
    }
  }, []);

  const setContextJump = useCallback(async (next: ContextJumpSetting) => {
    const clamped: ContextJumpSetting = {
      ...next,
      thresholdTokens: clampJumpTokens(next.thresholdTokens),
    };
    setContextJumpState(clamped);
    try {
      await Promise.all([
        api.saveSetting(
          CONTEXT_JUMP_ENABLED_SETTING_KEY,
          clamped.enabled ? "true" : "false",
        ),
        api.saveSetting(
          CONTEXT_JUMP_TOKENS_SETTING_KEY,
          String(clamped.thresholdTokens),
        ),
      ]);
    } catch (error) {
      console.error("Failed to save context jump setting:", error);
    }
  }, []);

  return (
    <SessionGaugesContext.Provider
      value={{
        contextPressure,
        setContextPressure,
        cacheTimerEnabled,
        setCacheTimerEnabled,
        contextJump,
        setContextJump,
        isLoading,
      }}
    >
      {children}
    </SessionGaugesContext.Provider>
  );
};

export const useSessionGauges = (): SessionGaugesContextType => {
  const ctx = useContext(SessionGaugesContext);
  if (!ctx) {
    throw new Error(
      "useSessionGauges must be used within a SessionGaugesProvider",
    );
  }
  return ctx;
};
