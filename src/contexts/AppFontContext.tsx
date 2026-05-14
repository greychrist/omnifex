import React, { createContext, useState, useContext, useCallback, useEffect } from "react";
import { api } from "@/lib/api";
import {
  isTypefaceId,
  resolveTypeface,
  type Typeface,
} from "@/lib/typefaceCatalog";
import { logAndForget } from "@/lib/fireAndLog";

const APP_FONT_STORAGE_KEY = "app_font";
const DEFAULT_APP_FONT: Typeface = "inter";

interface AppFontContextType {
  appFont: Typeface;
  setAppFont: (next: string) => Promise<void>;
  isLoading: boolean;
}

const AppFontContext = createContext<AppFontContextType | undefined>(undefined);

function applyAppFont(typeface: Typeface): void {
  const meta = resolveTypeface(typeface);
  document.documentElement.style.setProperty("--app-font-stack", meta.cssFamily);
}

export const AppFontProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [appFont, setAppFontState] = useState<Typeface>(DEFAULT_APP_FONT);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const raw = await api.getSetting(APP_FONT_STORAGE_KEY);
        const next: Typeface = isTypefaceId(raw) ? raw : DEFAULT_APP_FONT;
        if (cancelled) return;
        setAppFontState(next);
        applyAppFont(next);
      } catch (error) {
        console.error("Failed to load app font setting:", error);
        if (!cancelled) applyAppFont(DEFAULT_APP_FONT);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    logAndForget('app-font-context:load', load());
    return () => {
      cancelled = true;
    };
  }, []);

  const setAppFont = useCallback(async (next: string) => {
    if (!isTypefaceId(next)) return;
    try {
      setAppFontState(next);
      applyAppFont(next);
      await api.saveSetting(APP_FONT_STORAGE_KEY, next);
    } catch (error) {
      console.error("Failed to save app font setting:", error);
    }
  }, []);

  return (
    <AppFontContext.Provider value={{ appFont, setAppFont, isLoading }}>
      {children}
    </AppFontContext.Provider>
  );
};

export const useAppFont = (): AppFontContextType => {
  const ctx = useContext(AppFontContext);
  if (!ctx) {
    throw new Error("useAppFont must be used within an AppFontProvider");
  }
  return ctx;
};
