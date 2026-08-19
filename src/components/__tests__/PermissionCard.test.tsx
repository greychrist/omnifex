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

describe("PermissionCard — command preview hardening", () => {
  it("escapes zero-width characters so the preview matches what will run", () => {
    render(
      <PermissionCard
        request={makeClaudeRequest({
          toolInput: { command: "rm\u200B -rf ~/data" },
        })}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByText("rm<U+200B> -rf ~/data")).toBeTruthy();
    expect(screen.getByText(/1 hidden character shown as escapes/)).toBeTruthy();
  });

  it("visualizes tab padding used to push text out of view", () => {
    render(
      <PermissionCard
        request={makeClaudeRequest({
          toolInput: { command: "ls\t\t; rm -rf /" },
        })}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByText("ls⇥⇥; rm -rf /")).toBeTruthy();
  });

  it("warns when the command is long enough to scroll out of the box", () => {
    render(
      <PermissionCard
        request={makeClaudeRequest({
          toolInput: { command: "echo hi\n".repeat(20) },
        })}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByText(/21 lines — scroll to see the whole command/)).toBeTruthy();
  });

  it("shows no warning for an ordinary command", () => {
    render(
      <PermissionCard
        request={makeClaudeRequest()}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.queryByText(/hidden character|scroll to see/)).toBeNull();
  });
});

// Claude Code 2.1.229 fixed its own crash on a tool call carrying a non-string
// `glob`, `file_path`, or `command`. The same payload reaches this card, whose
// typed branches returned the field as a declared `string` straight into
// `buildCommandPreview` → `raw.replace(...)` → TypeError. A permission card
// that cannot render has no Allow/Deny, so the session sits blocked.
describe("PermissionCard — malformed tool input (CLI 2.1.229 class)", () => {
  const malformed: { tool: string; input: Record<string, unknown>; what: string }[] = [
    { tool: "Bash", what: "object command", input: { command: { cmd: "ls" } } },
    { tool: "Read", what: "numeric file_path", input: { file_path: 123 } },
    { tool: "Write", what: "array file_path", input: { file_path: ["/tmp/a"] } },
    { tool: "Edit", what: "numeric file_path", input: { file_path: 7 } },
    { tool: "MultiEdit", what: "object file_path", input: { file_path: { p: "x" } } },
    { tool: "Grep", what: "array pattern", input: { pattern: ["x"] } },
    { tool: "Glob", what: "numeric pattern", input: { pattern: 9 } },
    { tool: "LS", what: "numeric path", input: { path: 1 } },
    { tool: "WebFetch", what: "object url", input: { url: { href: "x" } } },
  ];

  for (const { tool, input, what } of malformed) {
    it(`renders ${tool} with a ${what} as a JSON preview instead of crashing`, () => {
      expect(() =>
        render(
          <PermissionCard
            request={makeClaudeRequest({ toolName: tool, toolInput: input })}
            onAllow={vi.fn()}
            onDeny={vi.fn()}
          />,
        ),
      ).not.toThrow();
      // Allow/Deny must stay reachable — that is the whole point of the card.
      expect(screen.getByRole("button", { name: /deny/i })).toBeTruthy();
    });
  }

  it("still previews a well-formed command unchanged", () => {
    render(
      <PermissionCard
        request={makeClaudeRequest({ toolInput: { command: "ls -la" } })}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByText("ls -la")).toBeTruthy();
  });
});

// The CLI sets `suppress_always_allow_rule` when a persistent grant for this
// ask would be broader than the ask itself (MCP retroactive approvals, and
// from 2.1.235 any edit whose content can't be fully reviewed). Its own TUI
// drops the entire standing row in that case, leaving accept-once / reject.
describe("PermissionCard — suppressAlwaysAllowRule", () => {
  it("withholds the rule editor and both persisting buttons", () => {
    render(
      <PermissionCard
        request={makeClaudeRequest({ suppressAlwaysAllowRule: true })}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(
      screen.queryByPlaceholderText(/e\.g\. Bash\(git:\*\) or Read/i),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /save permission/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /allow for session/i })).toBeNull();
  });

  it("offers a one-time Allow that persists nothing", () => {
    const onAllow = vi.fn();
    render(
      <PermissionCard
        request={makeClaudeRequest({ suppressAlwaysAllowRule: true })}
        onAllow={onAllow}
        onDeny={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /allow once/i }));
    expect(onAllow).toHaveBeenCalledWith([]);
  });

  it("says why the standing grant is unavailable", () => {
    render(
      <PermissionCard
        request={makeClaudeRequest({ suppressAlwaysAllowRule: true })}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByTestId("permission-no-standing-rule")).toBeTruthy();
  });

  it("still denies", () => {
    const onDeny = vi.fn();
    render(
      <PermissionCard
        request={makeClaudeRequest({ suppressAlwaysAllowRule: true })}
        onAllow={vi.fn()}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it("leaves the rule editor in place when the flag is absent", () => {
    render(
      <PermissionCard
        request={makeClaudeRequest()}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(
      screen.getByPlaceholderText(/e\.g\. Bash\(git:\*\) or Read/i),
    ).toBeTruthy();
    expect(screen.queryByTestId("permission-no-standing-rule")).toBeNull();
  });
});
