// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import React from "react";
import { AppFontProvider, useAppFont } from "../AppFontContext";

vi.mock("@/lib/api", () => ({
  api: {
    getSetting: vi.fn(),
    saveSetting: vi.fn(),
  },
}));

import { api } from "@/lib/api";

const Probe: React.FC<{ onState: (s: { font: string; setFont: (f: string) => Promise<void> | void }) => void }> = ({
  onState,
}) => {
  const ctx = useAppFont();
  onState({ font: ctx.appFont, setFont: ctx.setAppFont });
  return null;
};

describe("AppFontProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.style.removeProperty("--app-font-stack");
  });

  it("defaults to inter when no setting is stored", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    let captured = { font: "", setFont: (_: string) => {} };

    render(
      <AppFontProvider>
        <Probe onState={(s) => (captured = s)} />
      </AppFontProvider>,
    );

    await waitFor(() => { expect(captured.font).toBe("inter"); });
  });

  it("loads the stored value and applies --app-font-stack", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue("geist");
    let captured = { font: "", setFont: (_: string) => {} };

    render(
      <AppFontProvider>
        <Probe onState={(s) => (captured = s)} />
      </AppFontProvider>,
    );

    await waitFor(() => { expect(captured.font).toBe("geist"); });
    expect(document.documentElement.style.getPropertyValue("--app-font-stack")).toMatch(/Geist/);
  });

  it("falls back to inter when the stored value is invalid", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue("not-a-real-font");
    let captured = { font: "", setFont: (_: string) => {} };

    render(
      <AppFontProvider>
        <Probe onState={(s) => (captured = s)} />
      </AppFontProvider>,
    );

    await waitFor(() => { expect(captured.font).toBe("inter"); });
  });

  it("setAppFont persists and re-applies the CSS variable", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue("inter");
    (api.saveSetting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    let captured = { font: "", setFont: (_: string) => {} };

    render(
      <AppFontProvider>
        <Probe onState={(s) => (captured = s)} />
      </AppFontProvider>,
    );

    await waitFor(() => { expect(captured.font).toBe("inter"); });

    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- await on sync helper for test flow alignment.
      await captured.setFont("plus-jakarta");
    });

    expect(api.saveSetting).toHaveBeenCalledWith("app_font", "plus-jakarta");
    expect(document.documentElement.style.getPropertyValue("--app-font-stack")).toMatch(
      /Plus Jakarta Sans/,
    );
  });

  it("ignores invalid setAppFont values", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue("inter");
    let captured = { font: "", setFont: (_: string) => {} };

    render(
      <AppFontProvider>
        <Probe onState={(s) => (captured = s)} />
      </AppFontProvider>,
    );

    await waitFor(() => { expect(captured.font).toBe("inter"); });

    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- await on sync helper for test flow alignment.
      await captured.setFont("nonsense");
    });

    expect(captured.font).toBe("inter");
    expect(api.saveSetting).not.toHaveBeenCalled();
  });
});
