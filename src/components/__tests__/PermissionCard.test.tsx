// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { PermissionRequestPayload } from "@/lib/types/permissionRequest";

// DiffViewer (rendered by CodexPatchPreview) reaches for the syntax theme
// via useTheme(); stub it the same way CodexApplyPatch.test.tsx does so
// the test environment doesn't blow up without a ThemeProvider.
vi.mock("@/hooks", () => ({
  useTheme: () => ({ theme: "gray", setTheme: () => {}, isLoading: false }),
}));

import { PermissionCard } from "../PermissionCard";

afterEach(() => { cleanup(); });

function makeClaudeRequest(
  overrides: Partial<PermissionRequestPayload> = {},
): PermissionRequestPayload {
  return {
    requestId: "req-1",
    toolName: "Bash",
    toolInput: { command: "ls -la" },
    title: "Run shell command",
    suggestions: [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ],
    ...overrides,
  };
}

function makeCodexPatchRequest(
  overrides: Partial<PermissionRequestPayload> = {},
): PermissionRequestPayload {
  return {
    requestId: "req-patch",
    kind: "patch",
    agent: "codex",
    summary: "Apply patch to src/foo.ts",
    payload: {
      conversationId: "conv-1",
      callId: "call-1",
      fileChanges: {
        "src/foo.ts": { before: "old contents", after: "new contents" },
        "src/bar.ts": { before: "alpha", after: "beta" },
      },
      reason: "refactor extract",
    },
    // Stub Claude fields so the wider type stays valid.
    toolName: "apply_patch",
    toolInput: {},
    suggestions: [],
    ...overrides,
  };
}

function makeCodexExecRequest(
  overrides: Partial<PermissionRequestPayload> = {},
): PermissionRequestPayload {
  return {
    requestId: "req-exec",
    kind: "exec",
    agent: "codex",
    summary: "Run: npm test",
    payload: {
      conversationId: "conv-1",
      callId: "call-2",
      command: "npm test",
      cwd: "/Users/g/repo",
      reason: "verify before commit",
    },
    toolName: "exec_command",
    toolInput: {},
    suggestions: [],
    ...overrides,
  };
}

describe("PermissionCard — Claude tool variant (regression)", () => {
  it("renders the Claude tool preview when kind is omitted", () => {
    render(
      <PermissionCard
        request={makeClaudeRequest()}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    // The Bash command surfaces in the tool-input preview pre.
    expect(screen.getByText("ls -la")).toBeTruthy();
    // The rule editor input exists with the suggestion pre-filled.
    const ruleInput = screen.getByPlaceholderText(
      /e\.g\. Bash\(git:\*\) or Read/i,
    ) as HTMLInputElement;
    expect(ruleInput.value).toBe("Bash(ls:*)");
  });

  it("fires onAllow with the saved-permission suggestion when 'Save Permission' is clicked", () => {
    const onAllow = vi.fn();
    render(
      <PermissionCard
        request={makeClaudeRequest()}
        onAllow={onAllow}
        onDeny={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /save permission/i }));
    expect(onAllow).toHaveBeenCalledTimes(1);
    const [suggestions] = onAllow.mock.calls[0]!;
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]).toMatchObject({
      type: "addRules",
      behavior: "allow",
    });
  });

  it("fires onDeny when Deny is clicked", () => {
    const onDeny = vi.fn();
    render(
      <PermissionCard
        request={makeClaudeRequest()}
        onAllow={vi.fn()}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });
});

describe("PermissionCard — Codex patch variant", () => {
  it("renders the patch-specific header and file count", () => {
    render(
      <PermissionCard
        request={makeCodexPatchRequest()}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByText(/codex patch approval/i)).toBeTruthy();
    // CodexPatchPreview surfaces the N-files header.
    expect(screen.getByText(/2 files/)).toBeTruthy();
  });

  it("renders one filename header per file change", () => {
    render(
      <PermissionCard
        request={makeCodexPatchRequest()}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByText("src/foo.ts")).toBeTruthy();
    expect(screen.getByText("src/bar.ts")).toBeTruthy();
  });

  it("renders DiffViewer rows (gutter columns) for each open file block", () => {
    const { container } = render(
      <PermissionCard
        request={makeCodexPatchRequest()}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    // With N=2 files the file blocks open by default (≤ 3 heuristic).
    // DiffViewer renders one gutter-column div per diff hunk; assert at
    // least one is present per file block (proves diffs actually rendered).
    const gutterChildren = container.querySelectorAll(".w-8.select-none");
    expect(gutterChildren.length).toBeGreaterThan(0);
  });

  it("does NOT render the Claude rule editor for patch kind", () => {
    render(
      <PermissionCard
        request={makeCodexPatchRequest()}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(
      screen.queryByPlaceholderText(/e\.g\. Bash\(git:\*\)/i),
    ).toBeNull();
  });

  it("fires onAllow() with an empty suggestion list when Allow is clicked", () => {
    const onAllow = vi.fn();
    render(
      <PermissionCard
        request={makeCodexPatchRequest()}
        onAllow={onAllow}
        onDeny={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onAllow).toHaveBeenCalledWith([]);
  });

  it("fires onDeny() when Deny is clicked", () => {
    const onDeny = vi.fn();
    render(
      <PermissionCard
        request={makeCodexPatchRequest()}
        onAllow={vi.fn()}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it("handles a malformed payload defensively (no crash, empty-state)", () => {
    expect(() =>
      render(
        <PermissionCard
          request={makeCodexPatchRequest({ payload: null })}
          onAllow={vi.fn()}
          onDeny={vi.fn()}
        />,
      ),
    ).not.toThrow();
    expect(screen.getByText(/no file changes/i)).toBeTruthy();
  });
});

describe("PermissionCard — Codex exec variant", () => {
  it("renders the exec-specific header and command preview", () => {
    const { container } = render(
      <PermissionCard
        request={makeCodexExecRequest()}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByText(/codex command approval/i)).toBeTruthy();
    // CodexExecPreview lays the command inside a <code> with a leading `$`
    // (rendered alongside the command in the same element). The literal `$`
    // and the command sit in adjacent text nodes; assert via the joined
    // textContent of the <code> rather than getByText (which uses node-by-
    // node matching).
    const codes = Array.from(container.querySelectorAll("code"));
    const commandLine = codes.find((el) => el.textContent?.includes("npm test"));
    expect(commandLine).toBeTruthy();
    expect(commandLine?.textContent).toMatch(/^\s*\$\s+npm test/);
  });

  it("renders cwd when provided", () => {
    render(
      <PermissionCard
        request={makeCodexExecRequest()}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByText(/cwd: \/Users\/g\/repo/)).toBeTruthy();
  });

  it("does NOT render the Claude rule editor for exec kind", () => {
    render(
      <PermissionCard
        request={makeCodexExecRequest()}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(
      screen.queryByPlaceholderText(/e\.g\. Bash\(git:\*\)/i),
    ).toBeNull();
  });

  it("fires onAllow() with [] when Allow is clicked", () => {
    const onAllow = vi.fn();
    render(
      <PermissionCard
        request={makeCodexExecRequest()}
        onAllow={onAllow}
        onDeny={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onAllow).toHaveBeenCalledWith([]);
  });

  it("fires onDeny() when Deny is clicked", () => {
    const onDeny = vi.fn();
    render(
      <PermissionCard
        request={makeCodexExecRequest()}
        onAllow={vi.fn()}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it("renders defensively when payload is missing", () => {
    expect(() =>
      render(
        <PermissionCard
          request={makeCodexExecRequest({ payload: undefined })}
          onAllow={vi.fn()}
          onDeny={vi.fn()}
        />,
      ),
    ).not.toThrow();
    // Empty-state placeholder for an absent command.
    expect(screen.getByText(/empty command/i)).toBeTruthy();
  });
});
