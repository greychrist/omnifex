// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AgentMessage } from "@/lib/api";
import { CodexItemFallback } from "@/components/codex/items/CodexItemFallback";

afterEach(() => { cleanup(); });

function makeMessage(payload: unknown): AgentMessage {
  return {
    agent: "codex",
    tabId: "test-tab",
    receivedAt: "2026-05-27T00:00:00.000Z",
    sessionId: null,
    payload,
  };
}

describe("CodexItemFallback", () => {
  it("renders the unknown method name in the header", () => {
    render(
      <CodexItemFallback
        message={makeMessage({
          method: "item.new_codex_thing",
          params: { foo: 1 },
        })}
      />,
    );
    expect(screen.getByText(/Unknown Codex item:/)).toBeTruthy();
    expect(screen.getByText("item.new_codex_thing")).toBeTruthy();
  });

  it("renders the raw payload as JSON inside the details block", () => {
    render(
      <CodexItemFallback
        message={makeMessage({
          method: "item.weird",
          params: { hello: "world" },
        })}
      />,
    );
    // The <details> is collapsed by default; jsdom still renders inner
    // children in the DOM, so we can assert the JSON text is present.
    expect(screen.getByText(/"hello": "world"/)).toBeTruthy();
    expect(screen.getByText("raw payload")).toBeTruthy();
  });

  it("console.warns once with the unknown method name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <CodexItemFallback
        message={makeMessage({ method: "item.brand_new", params: {} })}
      />,
    );
    expect(warn).toHaveBeenCalled();
    const firstCall = warn.mock.calls[0]?.[0] as string;
    expect(firstCall).toContain("item.brand_new");
    warn.mockRestore();
  });

  it("falls back to 'unknown' when the payload has no method", () => {
    render(<CodexItemFallback message={makeMessage({ params: {} })} />);
    expect(screen.getByText("unknown")).toBeTruthy();
  });

  it("preserves the dispatch attribute on the root", () => {
    render(
      <CodexItemFallback message={makeMessage({ method: "x", params: {} })} />,
    );
    expect(document.querySelectorAll('[data-codex-item="fallback"]')).toHaveLength(1);
  });
});
