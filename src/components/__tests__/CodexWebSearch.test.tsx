// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { AgentMessage } from "@/lib/api";
import { WebSearchItem } from "@/components/codex/items/WebSearch";

afterEach(() => { cleanup(); });

const openExternal = vi.fn();

beforeEach(() => {
  openExternal.mockReset();
  openExternal.mockResolvedValue(undefined);
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    invoke: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    openExternal,
  };
});

function makeMessage(params: Record<string, unknown>): AgentMessage {
  return {
    agent: "codex",
    tabId: "test-tab",
    receivedAt: "2026-05-27T00:00:00.000Z",
    sessionId: null,
    payload: { method: "item.web_search", params },
  };
}

describe("WebSearchItem", () => {
  it("renders the query in the header", () => {
    render(
      <WebSearchItem
        message={makeMessage({ query: "best electron diff viewer", results: [] })}
      />,
    );
    expect(screen.getByText("best electron diff viewer")).toBeTruthy();
  });

  it("renders each result with title, url, and snippet", () => {
    render(
      <WebSearchItem
        message={makeMessage({
          query: "q",
          results: [
            {
              title: "First Result",
              url: "https://example.com/a",
              snippet: "snippet alpha",
            },
            {
              title: "Second Result",
              url: "https://example.com/b",
              snippet: "snippet beta",
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("First Result")).toBeTruthy();
    expect(screen.getByText("Second Result")).toBeTruthy();
    expect(screen.getByText("https://example.com/a")).toBeTruthy();
    expect(screen.getByText("https://example.com/b")).toBeTruthy();
    expect(screen.getByText("snippet alpha")).toBeTruthy();
    expect(screen.getByText("snippet beta")).toBeTruthy();
  });

  it("clicking a result calls electronAPI.openExternal with the URL", async () => {
    render(
      <WebSearchItem
        message={makeMessage({
          query: "q",
          results: [
            {
              title: "Clickable",
              url: "https://example.com/click",
              snippet: "snip",
            },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByText("Clickable"));
    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith("https://example.com/click");
    });
  });

  it("does not render a results list when results are empty", () => {
    render(<WebSearchItem message={makeMessage({ query: "q", results: [] })} />);
    expect(screen.queryByText(/example\.com/)).toBeNull();
  });

  it("renders defensively when params are missing", () => {
    const msg: AgentMessage = {
      agent: "codex",
      tabId: "t",
      receivedAt: "",
      sessionId: null,
      payload: { method: "item.web_search" },
    };
    expect(() => render(<WebSearchItem message={msg} />)).not.toThrow();
    expect(document.querySelectorAll('[data-codex-item="item.web_search"]')).toHaveLength(1);
  });

  it("preserves the dispatch attribute on the root for CodexTranscript", () => {
    render(<WebSearchItem message={makeMessage({ query: "q", results: [] })} />);
    expect(document.querySelectorAll('[data-codex-item="item.web_search"]')).toHaveLength(1);
  });
});
