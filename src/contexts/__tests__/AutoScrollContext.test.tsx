// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import React from "react";
import {
  AutoScrollProvider,
  useAutoScroll,
} from "../AutoScrollContext";
import {
  AUTOSCROLL_REENGAGE_SETTING_KEY,
  AUTOSCROLL_DISENGAGE_SETTING_KEY,
} from "@/lib/autoScrollThresholds";

vi.mock("@/lib/api", () => ({
  api: {
    getSetting: vi.fn(),
    saveSetting: vi.fn(),
  },
}));

import { api } from "@/lib/api";

type Ctx = ReturnType<typeof useAutoScroll>;

const Probe: React.FC<{ onState: (s: Ctx) => void }> = ({ onState }) => {
  const ctx = useAutoScroll();
  onState(ctx);
  return null;
};

describe("AutoScrollProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to 200/400 when nothing is stored", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    let latest: Ctx | undefined;
    render(
      <AutoScrollProvider>
        <Probe onState={(s) => (latest = s)} />
      </AutoScrollProvider>,
    );
    await waitFor(() => expect(latest?.isLoading).toBe(false));
    expect(latest?.reengagePx).toBe(200);
    expect(latest?.disengagePx).toBe(400);
  });

  it("loads stored values", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string) => {
        if (key === AUTOSCROLL_REENGAGE_SETTING_KEY) return Promise.resolve("150");
        if (key === AUTOSCROLL_DISENGAGE_SETTING_KEY) return Promise.resolve("300");
        return Promise.resolve(null);
      },
    );
    let latest: Ctx | undefined;
    render(
      <AutoScrollProvider>
        <Probe onState={(s) => (latest = s)} />
      </AutoScrollProvider>,
    );
    await waitFor(() => expect(latest?.reengagePx).toBe(150));
    expect(latest?.disengagePx).toBe(300);
  });

  it("persists and clamps on save (disengage never below reengage)", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (api.saveSetting as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    let latest: Ctx | undefined;
    render(
      <AutoScrollProvider>
        <Probe onState={(s) => (latest = s)} />
      </AutoScrollProvider>,
    );
    await waitFor(() => expect(latest?.isLoading).toBe(false));

    await act(async () => {
      await latest!.setThresholds({ reengagePx: 500, disengagePx: 200 });
    });

    expect(latest?.reengagePx).toBe(500);
    expect(latest?.disengagePx).toBe(500);
    expect(api.saveSetting).toHaveBeenCalledWith(
      AUTOSCROLL_REENGAGE_SETTING_KEY,
      "500",
    );
    expect(api.saveSetting).toHaveBeenCalledWith(
      AUTOSCROLL_DISENGAGE_SETTING_KEY,
      "500",
    );
  });
});
