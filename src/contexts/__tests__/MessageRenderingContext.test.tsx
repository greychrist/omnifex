// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import React from "react";
import {
  MessageRenderingProvider,
  useMessageRenderingConfig,
} from "../MessageRenderingContext";
import {
  createDefaultConfig,
  serializeConfig,
  type MessageRenderingConfig,
} from "@/lib/messageRenderingConfig";

vi.mock("@/lib/api", () => ({
  api: {
    getSetting: vi.fn(),
    saveSetting: vi.fn(),
  },
}));

import { api } from "@/lib/api";

const Probe: React.FC<{
  onState: (s: {
    config: MessageRenderingConfig;
    setConfig: (next: MessageRenderingConfig, persist?: boolean) => void;
  }) => void;
}> = ({ onState }) => {
  const ctx = useMessageRenderingConfig();
  onState({ config: ctx.config, setConfig: ctx.setConfig });
  return null;
};

describe("MessageRenderingProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.style.removeProperty("--chat-content-font");
    document.documentElement.style.removeProperty("--chat-content-size");
    document.documentElement.style.removeProperty("--chat-content-weight");
    document.documentElement.style.removeProperty("--font-terminal");
  });

  it("sets --chat-content-size and --chat-content-weight from the loaded content style", async () => {
    const stored = createDefaultConfig();
    stored.typography.content.size = "xxs";
    stored.typography.content.weight = "bold";
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue(serializeConfig(stored));

    render(
      <MessageRenderingProvider>
        <Probe onState={() => {}} />
      </MessageRenderingProvider>,
    );

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue("--chat-content-size"),
      ).toBe("0.625rem");
    });
    expect(
      document.documentElement.style.getPropertyValue("--chat-content-weight"),
    ).toBe("700");
  });

  it("re-applies --chat-content-size / --chat-content-weight when setConfig changes them", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (api.saveSetting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    let captured = {
      config: createDefaultConfig(),
      setConfig: (_: MessageRenderingConfig) => {},
    };

    render(
      <MessageRenderingProvider>
        <Probe onState={(s) => (captured = s)} />
      </MessageRenderingProvider>,
    );

    await waitFor(() => { expect(api.getSetting).toHaveBeenCalled(); });

    await act(async () => {
      const next = { ...captured.config };
      next.typography = {
        ...next.typography,
        content: { ...next.typography.content, size: "lg", weight: "light" },
      };
      captured.setConfig(next);
    });

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue("--chat-content-size"),
      ).toBe("1.125rem");
    });
    expect(
      document.documentElement.style.getPropertyValue("--chat-content-weight"),
    ).toBe("300");
  });

  it("sets --chat-content-font from the loaded typography.content.typeface", async () => {
    const stored = createDefaultConfig();
    stored.typography.content.typeface = "geist";
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue(serializeConfig(stored));

    let captured = {
      config: createDefaultConfig(),
      setConfig: (_: MessageRenderingConfig) => {},
    };

    render(
      <MessageRenderingProvider>
        <Probe onState={(s) => (captured = s)} />
      </MessageRenderingProvider>,
    );

    await waitFor(() =>
      { expect(captured.config.typography.content.typeface).toBe("geist"); },
    );
    await waitFor(() =>
      { expect(
        document.documentElement.style.getPropertyValue("--chat-content-font"),
      ).toMatch(/Geist/); },
    );
  });

  it("sets --font-terminal from the loaded terminal.typeface", async () => {
    const stored = createDefaultConfig();
    stored.terminal.typeface = "jetbrains-mono";
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue(serializeConfig(stored));

    let captured = {
      config: createDefaultConfig(),
      setConfig: (_: MessageRenderingConfig) => {},
    };

    render(
      <MessageRenderingProvider>
        <Probe onState={(s) => (captured = s)} />
      </MessageRenderingProvider>,
    );

    await waitFor(() => { expect(captured.config.terminal.typeface).toBe("jetbrains-mono"); });
    await waitFor(() =>
      { expect(
        document.documentElement.style.getPropertyValue("--font-terminal"),
      ).toMatch(/JetBrains Mono/); },
    );
  });

  it("re-applies --font-terminal when setConfig changes the terminal typeface", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (api.saveSetting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    let captured = {
      config: createDefaultConfig(),
      setConfig: (_: MessageRenderingConfig) => {},
    };

    render(
      <MessageRenderingProvider>
        <Probe onState={(s) => (captured = s)} />
      </MessageRenderingProvider>,
    );

    await waitFor(() => { expect(api.getSetting).toHaveBeenCalled(); });

    await act(async () => {
      const next = { ...captured.config };
      next.terminal = { ...next.terminal, typeface: "plex-mono" };
      captured.setConfig(next);
    });

    await waitFor(() =>
      { expect(
        document.documentElement.style.getPropertyValue("--font-terminal"),
      ).toMatch(/IBM Plex Mono/); },
    );
  });

  it("re-applies --chat-content-font when setConfig changes the content typeface", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (api.saveSetting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    let captured = {
      config: createDefaultConfig(),
      setConfig: (_: MessageRenderingConfig) => {},
    };

    render(
      <MessageRenderingProvider>
        <Probe onState={(s) => (captured = s)} />
      </MessageRenderingProvider>,
    );

    await waitFor(() => { expect(api.getSetting).toHaveBeenCalled(); });

    await act(async () => {
      const next = { ...captured.config };
      next.typography = {
        ...next.typography,
        content: { ...next.typography.content, typeface: "plus-jakarta" },
      };
      captured.setConfig(next);
    });

    await waitFor(() =>
      { expect(
        document.documentElement.style.getPropertyValue("--chat-content-font"),
      ).toMatch(/Plus Jakarta Sans/); },
    );
  });
});
