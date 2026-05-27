// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AgentMessage } from "@/lib/api";
import { McpToolCallItem } from "@/components/codex/items/McpToolCall";

afterEach(() => { cleanup(); });

function makeMessage(params: Record<string, unknown>): AgentMessage {
  return {
    agent: "codex",
    tabId: "test-tab",
    receivedAt: "2026-05-27T00:00:00.000Z",
    sessionId: null,
    payload: { method: "item.mcp_tool_call", params },
  };
}

describe("McpToolCallItem", () => {
  it("renders <serverName>.<toolName> in the header", () => {
    render(
      <McpToolCallItem
        message={makeMessage({
          serverName: "context7",
          toolName: "query-docs",
        })}
      />,
    );
    expect(screen.getByText("context7.query-docs")).toBeTruthy();
  });

  it("renders pretty-printed JSON input in a collapsed <details>", () => {
    render(
      <McpToolCallItem
        message={makeMessage({
          serverName: "s",
          toolName: "t",
          input: { foo: "bar", n: 42 },
        })}
      />,
    );
    // <details> is collapsed by default, but the inner <pre> still
    // exists in the DOM — jsdom doesn't strip non-open <details> children.
    expect(screen.getByText(/"foo": "bar"/)).toBeTruthy();
    expect(screen.getByText("input")).toBeTruthy();
  });

  it("renders a raw string output as-is (no JSON quote wrapping)", () => {
    render(
      <McpToolCallItem
        message={makeMessage({
          serverName: "s",
          toolName: "t",
          output: "plain text output line",
        })}
      />,
    );
    // No surrounding quotes — the widget recognizes string outputs and
    // surfaces them raw.
    expect(screen.getByText("plain text output line")).toBeTruthy();
  });

  it("renders structured object outputs as pretty-printed JSON", () => {
    render(
      <McpToolCallItem
        message={makeMessage({
          serverName: "s",
          toolName: "t",
          output: { ok: true, items: ["a", "b"] },
        })}
      />,
    );
    expect(screen.getByText(/"ok": true/)).toBeTruthy();
  });

  it("omits the input/output details blocks when the field is missing", () => {
    render(
      <McpToolCallItem
        message={makeMessage({ serverName: "s", toolName: "t" })}
      />,
    );
    expect(screen.queryByText("input")).toBeNull();
    expect(screen.queryByText("output")).toBeNull();
  });

  it("falls back to '(unknown MCP tool)' when both names are missing", () => {
    render(<McpToolCallItem message={makeMessage({})} />);
    expect(screen.getByText(/unknown MCP tool/i)).toBeTruthy();
  });

  it("renders defensively when params are missing entirely", () => {
    const msg: AgentMessage = {
      agent: "codex",
      tabId: "t",
      receivedAt: "",
      sessionId: null,
      payload: { method: "item.mcp_tool_call" },
    };
    expect(() => render(<McpToolCallItem message={msg} />)).not.toThrow();
    expect(document.querySelectorAll('[data-codex-item="item.mcp_tool_call"]')).toHaveLength(1);
  });

  it("preserves the dispatch attribute on the root for CodexTranscript", () => {
    render(
      <McpToolCallItem
        message={makeMessage({ serverName: "s", toolName: "t" })}
      />,
    );
    expect(document.querySelectorAll('[data-codex-item="item.mcp_tool_call"]')).toHaveLength(1);
  });
});
