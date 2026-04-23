import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import {
  MESSAGE_RENDERING_CONFIG_KEY,
  createDefaultConfig,
  parseConfig,
  serializeConfig,
  type MessageRenderingConfig,
} from "@/lib/messageRenderingConfig";

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
    (async () => {
      try {
        const raw = await api.getSetting(MESSAGE_RENDERING_CONFIG_KEY);
        if (!cancelled) setConfigState(parseConfig(raw));
      } catch {
        /* keep defaults */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
