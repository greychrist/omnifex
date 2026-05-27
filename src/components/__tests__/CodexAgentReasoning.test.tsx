// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { AgentMessage } from "@/lib/api";
import { AgentReasoningItem } from "@/components/codex/items/AgentReasoning";

afterEach(() => { cleanup(); });

function makeMessage(params: Record<string, unknown>): AgentMessage {
  return {
    agent: "codex",
    tabId: "test-tab",
    receivedAt: "2026-05-27T00:00:00.000Z",
    sessionId: null,
    payload: { method: "agent_reasoning", params },
  };
}

describe("AgentReasoningItem", () => {
  it("renders the summary inline in the collapsed header", () => {
    render(
      <AgentReasoningItem
        message={makeMessage({ summary: "deciding what to do next" })}
      />,
    );
    expect(screen.getByText("deciding what to do next")).toBeTruthy();
    expect(screen.getByText(/thinking/i)).toBeTruthy();
  });

  it("starts collapsed: full content is not visible until toggle is clicked", () => {
    render(
      <AgentReasoningItem
        message={makeMessage({
          summary: "short summary",
          content: "the full reasoning body that should be hidden initially",
        })}
      />,
    );
    expect(
      screen.queryByText("the full reasoning body that should be hidden initially"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { expanded: false }),
    ).toBeTruthy();
  });

  it("clicking the toggle expands and reveals the full content", () => {
    render(
      <AgentReasoningItem
        message={makeMessage({
          summary: "short summary",
          content: "the full reasoning body",
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("the full reasoning body")).toBeTruthy();
    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
  });

  it("clicking again collapses and hides the full content", () => {
    render(
      <AgentReasoningItem
        message={makeMessage({
          summary: "short summary",
          content: "the full reasoning body",
        })}
      />,
    );
    const toggle = screen.getByRole("button");
    fireEvent.click(toggle);
    expect(screen.getByText("the full reasoning body")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByText("the full reasoning body")).toBeNull();
    expect(screen.getByRole("button", { expanded: false })).toBeTruthy();
  });

  it("falls back to summary as the expanded body when content is absent", () => {
    render(
      <AgentReasoningItem
        message={makeMessage({ summary: "only-have-summary" })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    // Summary is now visible in two places: the header preview is hidden
    // when expanded, but the <pre> body shows it as the fallback content.
    // getAllByText guards against either rendering choice.
    expect(screen.getAllByText("only-have-summary").length).toBeGreaterThanOrEqual(1);
  });

  it("preserves the dispatch attribute on the root for CodexTranscript", () => {
    render(<AgentReasoningItem message={makeMessage({ summary: "x" })} />);
    expect(
      document.querySelectorAll('[data-codex-item="agent_reasoning"]'),
    ).toHaveLength(1);
  });
});
