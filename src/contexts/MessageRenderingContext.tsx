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
import { FONT_SIZE_REM, FONT_WEIGHT_VALUE } from "@/lib/typographyClasses";
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
        const parsed = parseConfig(raw);            // resets non-v5 to defaults
        let wasReset = !raw;
        try {
          wasReset = wasReset || (JSON.parse(raw ?? 'null') as { version?: unknown } | null)?.version !== 5;
        } catch {
          wasReset = true;
        }
        if (wasReset && !cancelled) {
          await api.saveSetting(MESSAGE_RENDERING_CONFIG_KEY, serializeConfig(parsed));
          await api.logWriteBatch([{
            timestamp: new Date().toISOString(),
            level: 'info',
            source: 'frontend',
            category: 'settings:message-rendering',
            message: 'reset message rendering config to v5 defaults',
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

  // Mirror the chat Content typeface to a CSS variable on :root so any
  // markdown/prose surface in the chat (assistant text, thinking, tool
  // widgets, fenced markdown blocks) can pick it up via a single rule in
  // styles.css. Without this, those surfaces inherit body's --font-sans —
  // i.e. the App font — which makes the chat Content picker look like it
  // only affects the user-prompt body.
  //
  // Size and weight ride the same mechanism (`--chat-content-size` /
  // `--chat-content-weight`). They CAN'T go through the Tailwind class path
  // (contentClassNames) like the header does: the content body renders inside
  // `.prose` / `.prose-sm`, whose own `font-size` rules in styles.css beat
  // utility classes — so without these variables only the typeface changed
  // and size/weight were silently ignored.
  const { typeface, size, weight } = config.typography.content;
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--chat-content-font", resolveTypeface(typeface).cssFamily);
    root.setProperty("--chat-content-size", FONT_SIZE_REM[size]);
    root.setProperty("--chat-content-weight", String(FONT_WEIGHT_VALUE[weight]));
  }, [typeface, size, weight]);

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
