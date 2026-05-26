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
        if (!cancelled) setConfigState(parseConfig(raw));
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
