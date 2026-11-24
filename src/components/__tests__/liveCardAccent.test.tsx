// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MessageRenderingPreviewProvider } from "@/contexts/MessageRenderingContext";
import { createDefaultConfig } from "@/lib/messageRenderingConfig";
import { accentStyleFor } from "@/lib/accentStyle";
import { PermissionCard } from "@/components/PermissionCard";
import type { PermissionRequestPayload } from "@/lib/types/permissionRequest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeClaudeRequest(): PermissionRequestPayload {
  return {
    requestId: "req-accent-test",
    kind: "tool",
    toolName: "Bash",
    toolInput: { command: "echo hello" },
    title: "Run shell command",
    suggestions: [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "echo:*" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ],
  };
}

describe("Live card accent regression — B2", () => {
  it("PermissionCard outer card paints the amber accent (#f59e0b33), not category-muted gray", () => {
    const cfg = createDefaultConfig();
    const request = makeClaudeRequest();

    const { container } = render(
      <MessageRenderingPreviewProvider config={cfg}>
        <PermissionCard
          request={request}
          onAllow={() => {}}
          onDeny={() => {}}
        />
      </MessageRenderingPreviewProvider>,
    );

    const card = container.querySelector<HTMLElement>("div[style]");
    expect(card).not.toBeNull();

    // jsdom normalizes #rrggbbaa to rgba(); amber #f59e0b is rgb 245,158,11.
    const borderColor = card!.style.borderColor;
    const rgbMatch = /rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(borderColor);
    expect(rgbMatch).not.toBeNull();
    const [, r, g, b] = rgbMatch!.map(Number);
    expect(r).toBe(245);
    expect(g).toBe(158);
    expect(b).toBe(11);
  });

  it("accentStyleFor resolves permission.askUserQuestion to the indigo swatch (#6366f133)", () => {
    const cfg = createDefaultConfig();
    const style = accentStyleFor(cfg, "permission.askUserQuestion");

    // Raw hex, before jsdom normalization: indigo #6366f1 with alpha 33.
    expect(style).toBeDefined();
    expect(style!.borderColor).toBe("#6366f133");
  });
});
