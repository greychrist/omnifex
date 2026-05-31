// @vitest-environment jsdom
/**
 * Regression: live prompt cards (PermissionCard, AskUserQuestionCard) must
 * paint their per-kind accent colour, not the category-muted gray that the
 * system category base would supply if the unified `accentStyleFor` helper is
 * bypassed.
 *
 * Phase B2 guard:
 *  - Test 1 (render): PermissionCard outer border is amber (#f59e0b55), not gray.
 *  - Test 2 (unit): accentStyleFor resolves permission.askUserQuestion to
 *    indigo (#6366f155), confirming AskUserQuestionCard's new import path works.
 */
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
  it("PermissionCard outer card paints the amber accent (#f59e0b55), not category-muted gray", () => {
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

    // The PermissionCard (non-Codex branch) renders:
    //   <div className="mx-2 my-2 rounded-lg border shadow-sm" style={accentStyle}>
    // That is the first div with an inline style in the subtree.
    const card = container.querySelector("div[style]") as HTMLElement | null;
    expect(card).not.toBeNull();

    // permission.request → amber palette → swatch #f59e0b → border #f59e0b55.
    // jsdom normalizes #rrggbbaa hex to rgba(). We assert using the rounded
    // RGB channels that uniquely identify amber (#f59e0b = rgb 245,158,11).
    // The muted/category-gray swatch (#4b5563 = rgb 75,85,99) would produce
    // different channel values and would fail this assertion.
    const borderColor = card!.style.borderColor;
    // rgba() parse: extract r,g,b channels from the browser-normalized value.
    const rgbMatch = borderColor.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
    expect(rgbMatch).not.toBeNull();
    const [, r, g, b] = rgbMatch!.map(Number);
    // Amber #f59e0b → r=245, g=158, b=11
    expect(r).toBe(245);
    expect(g).toBe(158);
    expect(b).toBe(11);
  });

  it("accentStyleFor resolves permission.askUserQuestion to the indigo swatch (#6366f155)", () => {
    const cfg = createDefaultConfig();
    const style = accentStyleFor(cfg, "permission.askUserQuestion");

    // indigo palette entry: swatch = #6366f1 → border alpha = 55 → #6366f155
    // This is a pure function test — the returned CSSProperties object has
    // the raw hex string as produced by accentStyleFromEntry, before any
    // browser/jsdom color normalization.
    expect(style).toBeDefined();
    expect(style!.borderColor).toBe("#6366f155");
  });
});
