// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { AgentMessage } from "@/lib/api";

// DiffViewer pulls the syntax theme via useTheme(), which would otherwise
// throw without a ThemeProvider. Matches the pattern from
// CodexAgentMessage.test.tsx.
vi.mock("@/hooks", () => ({
  useTheme: () => ({ theme: "gray", setTheme: () => {}, isLoading: false }),
}));

import { ApplyPatchItem } from "@/components/codex/items/ApplyPatch";

afterEach(() => { cleanup(); });

function makeMessage(params: Record<string, unknown>): AgentMessage {
  return {
    agent: "codex",
    tabId: "test-tab",
    receivedAt: "2026-05-27T00:00:00.000Z",
    sessionId: null,
    payload: { method: "item.apply_patch", params },
  };
}

describe("ApplyPatchItem", () => {
  it("renders an N-files header with the correct count and singular/plural", () => {
    render(
      <ApplyPatchItem
        message={makeMessage({
          fileChanges: {
            "src/foo.ts": { before: "a", after: "b" },
          },
        })}
      />,
    );
    expect(screen.getByText(/Applied patch \(1 file\)/)).toBeTruthy();

    cleanup();

    render(
      <ApplyPatchItem
        message={makeMessage({
          fileChanges: {
            "a.ts": { before: "", after: "x" },
            "b.ts": { before: "", after: "y" },
          },
        })}
      />,
    );
    expect(screen.getByText(/Applied patch \(2 files\)/)).toBeTruthy();
  });

  it("renders the reason text when provided", () => {
    render(
      <ApplyPatchItem
        message={makeMessage({
          fileChanges: { "a.ts": { before: "", after: "x" } },
          reason: "refactor extract",
        })}
      />,
    );
    expect(screen.getByText(/refactor extract/)).toBeTruthy();
  });

  it("renders one filename header per file change", () => {
    render(
      <ApplyPatchItem
        message={makeMessage({
          fileChanges: {
            "src/foo.ts": { before: "a", after: "b" },
            "src/bar.ts": { before: "c", after: "d" },
          },
        })}
      />,
    );
    expect(screen.getByText("src/foo.ts")).toBeTruthy();
    expect(screen.getByText("src/bar.ts")).toBeTruthy();
  });

  it("renders DiffViewer content (diff rows) inline by default when N ≤ 3", () => {
    // With N=1 file the file block is open by default — the DiffViewer
    // renders its diff rows under the filename. We assert by counting
    // the "+" / "-" gutter markers DiffViewer emits.
    const { container } = render(
      <ApplyPatchItem
        message={makeMessage({
          fileChanges: {
            "src/foo.ts": { before: "old", after: "new" },
          },
        })}
      />,
    );
    // DiffViewer renders one gutter-column div per diff hunk; assert at
    // least one is present (proves the diff actually rendered).
    const gutterChildren = container.querySelectorAll(".w-8.select-none");
    expect(gutterChildren.length).toBeGreaterThan(0);
  });

  it("collapses file blocks by default when N > 3", () => {
    render(
      <ApplyPatchItem
        message={makeMessage({
          fileChanges: {
            "a.ts": { before: "", after: "x" },
            "b.ts": { before: "", after: "y" },
            "c.ts": { before: "", after: "z" },
            "d.ts": { before: "", after: "w" },
          },
        })}
      />,
    );
    // All 4 filename toggles render, all start collapsed.
    const buttons = screen.getAllByRole("button", { expanded: false });
    expect(buttons.length).toBe(4);
  });

  it("expands a collapsed file block on click", () => {
    render(
      <ApplyPatchItem
        message={makeMessage({
          fileChanges: {
            "a.ts": { before: "", after: "x" },
            "b.ts": { before: "", after: "y" },
            "c.ts": { before: "", after: "z" },
            "d.ts": { before: "", after: "w" },
          },
        })}
      />,
    );
    const firstToggle = screen.getAllByRole("button", { expanded: false })[0]!;
    fireEvent.click(firstToggle);
    expect(firstToggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("accepts fileChanges as an array of {path, before, after}", () => {
    render(
      <ApplyPatchItem
        message={makeMessage({
          fileChanges: [
            { path: "x.ts", before: "a", after: "b" },
            { path: "y.ts", before: "c", after: "d" },
          ],
        })}
      />,
    );
    expect(screen.getByText("x.ts")).toBeTruthy();
    expect(screen.getByText("y.ts")).toBeTruthy();
  });

  it("coerces `lines: string[]` side shapes into strings for the diff viewer", () => {
    // Some Codex builds ship before/after as { lines: string[] } instead
    // of plain strings. The widget should not throw and should still
    // surface the filename header.
    expect(() =>
      render(
        <ApplyPatchItem
          message={makeMessage({
            fileChanges: {
              "a.ts": {
                before: { lines: ["old line 1", "old line 2"] },
                after: { lines: ["new line 1"] },
              },
            },
          })}
        />,
      ),
    ).not.toThrow();
    expect(screen.getByText("a.ts")).toBeTruthy();
  });

  it("renders an empty-state when fileChanges is empty/missing", () => {
    render(<ApplyPatchItem message={makeMessage({ fileChanges: {} })} />);
    expect(screen.getByText(/no file changes/i)).toBeTruthy();
  });

  it("renders defensively when params are missing entirely", () => {
    const msg: AgentMessage = {
      agent: "codex",
      tabId: "t",
      receivedAt: "",
      sessionId: null,
      payload: { method: "item.apply_patch" },
    };
    expect(() => render(<ApplyPatchItem message={msg} />)).not.toThrow();
    expect(document.querySelectorAll('[data-codex-item="item.apply_patch"]')).toHaveLength(1);
  });

  it("preserves the dispatch attribute on the root for CodexTranscript", () => {
    render(<ApplyPatchItem message={makeMessage({ fileChanges: {} })} />);
    expect(document.querySelectorAll('[data-codex-item="item.apply_patch"]')).toHaveLength(1);
  });
});
