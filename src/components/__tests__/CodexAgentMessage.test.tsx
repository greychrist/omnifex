// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AgentMessage } from "@/lib/api";

// AgentMessageItem pulls the syntax theme via useTheme(), which would
// otherwise throw without a ThemeProvider. The 'gray' theme matches
// production default (same pattern as MarkdownBlock.test.tsx).
vi.mock("@/hooks", () => ({
  useTheme: () => ({ theme: "gray", setTheme: () => {}, isLoading: false }),
}));

import { AgentMessageItem } from "@/components/codex/items/AgentMessage";

afterEach(() => { cleanup(); });

function makeMessage(params: Record<string, unknown>): AgentMessage {
  return {
    agent: "codex",
    tabId: "test-tab",
    receivedAt: "2026-05-27T00:00:00.000Z",
    sessionId: null,
    payload: { method: "agent_message", params },
  };
}

describe("AgentMessageItem", () => {
  it("renders the message content as plain text", () => {
    render(<AgentMessageItem message={makeMessage({ content: "hello world" })} />);
    expect(screen.getByText("hello world")).toBeTruthy();
  });

  it("renders markdown content via the shared markdown pipeline (bold → <strong>)", () => {
    render(<AgentMessageItem message={makeMessage({ content: "**bold**" })} />);
    const strong = document.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe("bold");
  });

  it("shows the Codex role tag", () => {
    render(<AgentMessageItem message={makeMessage({ content: "hi" })} />);
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("preserves the dispatch attribute on the root for CodexTranscript", () => {
    render(<AgentMessageItem message={makeMessage({ content: "hi" })} />);
    // CodexTranscript's existing tests query by this attribute — keeping it
    // on the new root ensures Task 19's dispatch test stays green.
    expect(document.querySelectorAll('[data-codex-item="agent_message"]')).toHaveLength(1);
  });

  it("renders an empty card when content is missing (defensive)", () => {
    // Some Codex builds have shipped subtly different params shapes. The
    // widget should degrade gracefully rather than crashing the transcript.
    const msg: AgentMessage = {
      agent: "codex",
      tabId: "t",
      receivedAt: "",
      sessionId: null,
      payload: { method: "agent_message", params: {} },
    };
    expect(() => render(<AgentMessageItem message={msg} />)).not.toThrow();
    expect(document.querySelectorAll('[data-codex-item="agent_message"]')).toHaveLength(1);
  });
});
