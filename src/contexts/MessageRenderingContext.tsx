import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { api } from "@/lib/api";
import {
  MESSAGE_RENDERING_CONFIG_KEY,
  LEGACY_MESSAGE_RENDERING_CONFIG_KEY,
  createDefaultConfig,
  modernCssVars,
  parseConfig,
  serializeConfig,
  type MessageRenderingConfig,
} from "@/lib/messageRenderingConfig";
import { resolveTypeface } from "@/lib/typefaceCatalog";
import { FONT_SIZE_REM, FONT_WEIGHT_VALUE } from "@/lib/typographyClasses";
import { logAndForget } from "@/lib/fireAndLog";

interface MessageRenderingContextValue {
  config: MessageRenderingConfig;
  setConfig: (next: MessageRenderingConfig, persist?: boolean) => Promise<void>;
  loaded: boolean;
}

export const MessageRenderingContext = createContext<MessageRenderingContextValue | undefined>(undefined);

export const MessageRenderingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [config, setConfigState] = useState<MessageRenderingConfig>(() => createDefaultConfig());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    logAndForget('message-rendering-context:iife', (async () => {
      try {
        const current = await api.getSetting(MESSAGE_RENDERING_CONFIG_KEY);
        const raw = current ?? await api.getSetting(LEGACY_MESSAGE_RENDERING_CONFIG_KEY);
        const parsed = parseConfig(raw);
        let savedVersion: unknown = null;
        try {
          savedVersion = (JSON.parse(raw ?? 'null') as { version?: unknown } | null)?.version ?? null;
        } catch { /* unreadable: a reset */ }
        const loadedAsIs = current !== null && savedVersion === 6;
        const wasMigrated = current === null && savedVersion === 5;
        if (!loadedAsIs && !cancelled) {
          await api.saveSetting(MESSAGE_RENDERING_CONFIG_KEY, serializeConfig(parsed));
          await api.logWriteBatch([{
            timestamp: new Date().toISOString(),
            level: 'info',
            source: 'frontend',
            category: 'settings:message-rendering',
            message: wasMigrated
              ? 'migrated message rendering config v5 to v6 (Standard and Expanded)'
              : 'reset message rendering config to defaults',
          }]);
        }
        if (!cancelled) setConfigState(parsed);
      } catch {
        /* keep defaults */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })());
    return () => { cancelled = true; };
  }, []);

  // Size and weight must be CSS variables, not utility classes: `.prose` font-size rules in styles.css beat them.
  const { typeface, size, weight } = config.typography.content;
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--chat-content-font", resolveTypeface(typeface).cssFamily);
    root.setProperty("--chat-content-size", FONT_SIZE_REM[size]);
    root.setProperty("--chat-content-weight", String(FONT_WEIGHT_VALUE[weight]));
  }, [typeface, size, weight]);

  useEffect(() => {
    const stack = resolveTypeface(config.terminal.typeface).cssFamily;
    document.documentElement.style.setProperty("--font-terminal", stack);
  }, [config.terminal.typeface]);

  const modern = config.modern;
  useEffect(() => {
    const root = document.documentElement.style;
    for (const [name, value] of Object.entries(modernCssVars(modern))) {
      if (value === null) root.removeProperty(name);
      else root.setProperty(name, value);
    }
  }, [modern]);

  const setConfig = useCallback(async (next: MessageRenderingConfig, persist = true) => {
    setConfigState(next);
    if (persist) {
      await api.saveSetting(MESSAGE_RENDERING_CONFIG_KEY, serializeConfig(next));
    }
  }, []);

  // Memoized: every chat message subscribes to this context.
  const value = useMemo(() => ({ config, setConfig, loaded }), [config, setConfig, loaded]);

  return (
    <MessageRenderingContext.Provider value={value}>
      {children}
    </MessageRenderingContext.Provider>
  );
};

/** `setConfig` is a no-op. */
export const MessageRenderingPreviewProvider: React.FC<{
  config: MessageRenderingConfig;
  children: React.ReactNode;
}> = ({ config, children }) => (
  <MessageRenderingContext.Provider value={{ config, setConfig: async () => {}, loaded: true }}>
    {children}
  </MessageRenderingContext.Provider>
);

/** Memoized: every transcript row reads this context. */
export const MessageRenderingOverrideProvider: React.FC<{
  config: MessageRenderingConfig;
  children: React.ReactNode;
}> = ({ config, children }) => {
  const { setConfig, loaded } = useMessageRenderingConfig();
  const value = useMemo(() => ({ config, setConfig, loaded }), [config, setConfig, loaded]);
  return (
    <MessageRenderingContext.Provider value={value}>
      {children}
    </MessageRenderingContext.Provider>
  );
};

export function useMessageRenderingConfig(): MessageRenderingContextValue {
  const ctx = useContext(MessageRenderingContext);
  if (!ctx) {
    return {
      config: createDefaultConfig(),
      setConfig: async () => {},
      loaded: true,
    };
  }
  return ctx;
}
