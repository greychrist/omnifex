// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import React from "react";
import {
  AutoScrollProvider,
  useAutoScroll,
} from "../AutoScrollContext";
import { AUTOSCROLL_FOLLOW_SETTING_KEY } from "@/lib/autoScrollFollow";

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

  it("defaults to 200 when nothing is stored", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    let latest: Ctx | undefined;
    render(
      <AutoScrollProvider>
        <Probe onState={(s) => (latest = s)} />
      </AutoScrollProvider>,
    );
    await waitFor(() => expect(latest?.isLoading).toBe(false));
    expect(latest?.followPx).toBe(200);
  });

  it("loads the stored value", async () => {
    (api.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string) =>
        Promise.resolve(key === AUTOSCROLL_FOLLOW_SETTING_KEY ? "150" : null),
    );
    let latest: Ctx | undefined;
    render(
      <AutoScrollProvider>
        <Probe onState={(s) => (latest = s)} />
      </AutoScrollProvider>,
    );
    await waitFor(() => expect(latest?.followPx).toBe(150));
  });

  it("persists on save and clamps negatives to 0", async () => {
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
      await latest!.setFollowPx(-20);
    });

    expect(latest?.followPx).toBe(0);
    expect(api.saveSetting).toHaveBeenCalledWith(AUTOSCROLL_FOLLOW_SETTING_KEY, "0");
  });
});
