// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { AgentMessage } from "@/lib/api";
import { ExecCommandItem } from "@/components/codex/items/ExecCommand";

afterEach(() => { cleanup(); });

function makeMessage(params: Record<string, unknown>): AgentMessage {
  return {
    agent: "codex",
    tabId: "test-tab",
    receivedAt: "2026-05-27T00:00:00.000Z",
    sessionId: null,
    payload: { method: "item.exec_command", params },
  };
}

describe("ExecCommandItem", () => {
  it("renders the command with a $ prefix", () => {
    const { container } = render(
      <ExecCommandItem message={makeMessage({ command: "ls -la" })} />,
    );
    // The "$ " prefix and the command live as sibling text nodes inside
    // one <code> element. Match by the <code>'s combined textContent.
    const code = container.querySelector("code");
    expect(code?.textContent).toContain("$");
    expect(code?.textContent).toContain("ls -la");
  });

  it("renders the cwd line when provided", () => {
    render(
      <ExecCommandItem
        message={makeMessage({ command: "ls", cwd: "/tmp/foo" })}
      />,
    );
    expect(screen.getByText(/cwd: \/tmp\/foo/)).toBeTruthy();
  });

  it("renders a status badge in 'completed' tone", () => {
    render(
      <ExecCommandItem
        message={makeMessage({ command: "ls", status: "completed" })}
      />,
    );
    expect(screen.getByText("completed")).toBeTruthy();
  });

  it("renders a status badge in 'failed' tone", () => {
    render(
      <ExecCommandItem
        message={makeMessage({ command: "ls", status: "failed" })}
      />,
    );
    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("defaults the status badge to 'running' when status is missing", () => {
    render(<ExecCommandItem message={makeMessage({ command: "ls" })} />);
    expect(screen.getByText("running")).toBeTruthy();
  });

  it("renders short stdout inline (open by default under the 200-char limit)", () => {
    render(
      <ExecCommandItem
        message={makeMessage({ command: "ls", stdout: "hello world" })}
      />,
    );
    expect(screen.getByText("hello world")).toBeTruthy();
  });

  it("collapses long stdout behind a toggle, expandable on click", () => {
    const longStdout = "a".repeat(500);
    render(
      <ExecCommandItem
        message={makeMessage({ command: "ls", stdout: longStdout })}
      />,
    );
    // Initially collapsed — the long stdout body should not be visible.
    expect(screen.queryByText(longStdout)).toBeNull();
    // The toggle button shows the char count.
    expect(screen.getByText(/500 chars/)).toBeTruthy();
    // Click the stdout toggle.
    fireEvent.click(screen.getByRole("button", { name: /stdout/ }));
    expect(screen.getByText(longStdout)).toBeTruthy();
  });

  it("renders stderr alongside stdout when both are present", () => {
    render(
      <ExecCommandItem
        message={makeMessage({
          command: "ls",
          stdout: "out-data",
          stderr: "err-data",
        })}
      />,
    );
    expect(screen.getByText("out-data")).toBeTruthy();
    expect(screen.getByText("err-data")).toBeTruthy();
  });

  it("does not render stdout/stderr blocks when both are empty", () => {
    render(<ExecCommandItem message={makeMessage({ command: "ls" })} />);
    expect(screen.queryByRole("button", { name: /stdout/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /stderr/ })).toBeNull();
  });

  it("copies the command to the clipboard via navigator.clipboard.writeText", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<ExecCommandItem message={makeMessage({ command: "ls -la" })} />);
    fireEvent.click(screen.getByRole("button", { name: /copy command/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("ls -la");
    });
  });

  it("renders defensively when params are missing", () => {
    const msg: AgentMessage = {
      agent: "codex",
      tabId: "t",
      receivedAt: "",
      sessionId: null,
      payload: { method: "item.exec_command" },
    };
    expect(() => render(<ExecCommandItem message={msg} />)).not.toThrow();
    expect(document.querySelectorAll('[data-codex-item="item.exec_command"]')).toHaveLength(1);
  });

  it("preserves the dispatch attribute on the root for CodexTranscript", () => {
    render(<ExecCommandItem message={makeMessage({ command: "ls" })} />);
    expect(document.querySelectorAll('[data-codex-item="item.exec_command"]')).toHaveLength(1);
  });
});

beforeEach(() => {
  // Reset clipboard between tests.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});
