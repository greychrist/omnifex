import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import {
  MESSAGE_RENDERING_CONFIG_KEY,
  createDefaultConfig,
  parseConfig,
  serializeConfig,
  type MessageRenderingConfig,
} from "@/lib/messageRenderingConfig";
import { resolveTypeface } from "@/lib/typefaceCatalog";
import { logAndForget } from "@/lib/fireAndLog";

interface MessageRenderingContextValue {
  config: MessageRenderingConfig;
  setConfig: (next: MessageRenderingConfig, persist?: boolean) => void;
  loaded: boolean;
}

const MessageRenderingContext = createContext<MessageRenderingContextValue | undefined>(undefined);

export const MessageRenderingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [config, setConfigState] = useState<MessageRenderingConfig>(() => createDefaultConfig());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    logAndForget('message-rendering-context:iife', (async () => {
      try {
        const raw = await api.getSetting(MESSAGE_RENDERING_CONFIG_KEY);
        // Version guard: pre-v2 (or missing) configs are reset to fresh
        // defaults; v2 and v3 flow through mergeConfig, which migrates v2→v3
        // and passes v3 through. The migration is recorded in app_logs only on
        // the hard reset path (same pattern as the original v1→v2 reset).
        let parsed: unknown = null;
        try { parsed = raw ? (JSON.parse(raw) as unknown) : null; } catch { /* handled below */ }
        const persistedVersion =
          parsed !== null && typeof parsed === 'object' && parsed !== null && 'version' in parsed
            ? (parsed as { version?: unknown }).version
            : undefined;
        if (!raw || (typeof persistedVersion === 'number' ? persistedVersion : 1) < 2) {
          const fresh = createDefaultConfig();
          if (!cancelled) {
            await api.saveSetting(MESSAGE_RENDERING_CONFIG_KEY, JSON.stringify(fresh));
            await api.logWriteBatch([{
              timestamp: new Date().toISOString(),
              level: 'info',
              source: 'frontend',
              category: 'settings:message-rendering',
              message: 'reset message rendering config to v3 defaults',
            }]);
            setConfigState(fresh);
          }
        } else {
          if (!cancelled) setConfigState(parseConfig(raw));
        }
      } catch {
        /* keep defaults */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })());
    return () => {
      cancelled = true;
    };
  }, []);

  // Mirror the chat Content typeface to a CSS variable on :root so any
  // markdown/prose surface in the chat (assistant text, thinking, tool
  // widgets, fenced markdown blocks) can pick it up via a single rule in
  // styles.css. Without this, those surfaces inherit body's --font-sans —
  // i.e. the App font — which makes the chat Content picker look like it
  // only affects the user-prompt body.
  useEffect(() => {
    const stack = resolveTypeface(config.typography.content.typeface).cssFamily;
    document.documentElement.style.setProperty("--chat-content-font", stack);
  }, [config.typography.content.typeface]);

  // Same pattern for the TUI terminal. TerminalView reads `--font-terminal`
  // first, falling back to `--font-mono`, so a missing var (e.g. context
  // not wrapped) means the user gets the global mono default instead of an
  // empty stack.
  useEffect(() => {
    const stack = resolveTypeface(config.terminal.typeface).cssFamily;
    document.documentElement.style.setProperty("--font-terminal", stack);
  }, [config.terminal.typeface]);

  const setConfig = useCallback((next: MessageRenderingConfig, persist = true) => {
    setConfigState(next);
    if (persist) {
      api.saveSetting(MESSAGE_RENDERING_CONFIG_KEY, serializeConfig(next)).catch(() => {
        /* settings UI surfaces its own toast */
      });
    }
  }, []);

  return (
    <MessageRenderingContext.Provider value={{ config, setConfig, loaded }}>
      {children}
    </MessageRenderingContext.Provider>
  );
};

/**
 * Supplies an explicit config to a subtree without touching the live persisted
 * config. Used by the Appearance preview so sample messages render through the
 * real MessageFrame against a synthesized config (a category style, or an
 * in-progress override edit). `setConfig` is a no-op.
 */
export const MessageRenderingPreviewProvider: React.FC<{
  config: MessageRenderingConfig;
  children: React.ReactNode;
}> = ({ config, children }) => (
  <MessageRenderingContext.Provider value={{ config, setConfig: () => {}, loaded: true }}>
    {children}
  </MessageRenderingContext.Provider>
);

export function useMessageRenderingConfig(): MessageRenderingContextValue {
  const ctx = useContext(MessageRenderingContext);
  if (!ctx) {
    // Graceful fallback for any component rendered outside the provider
    // (e.g. isolated tests). Returns defaults; updates are silently dropped.
    return {
      config: createDefaultConfig(),
      setConfig: () => {},
      loaded: true,
    };
  }
  return ctx;
}
