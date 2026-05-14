import { describe, it, expect } from "vitest";
import type { ClaudeStreamMessage } from "@/types/claudeStream";
import { isSubagentDispatch, isSubagentPrompt } from "../subagentDispatch";

describe("isSubagentDispatch", () => {
  // The Claude Agent SDK and Claude Code CLI emit subagent dispatches under
  // PascalCase 'Task' / 'Agent' on the wire. Earlier defense-in-depth
  // accepted lowercase / uppercase variants too, but no production code
  // path actually emits those — verified via session reducer + JSONL replay
  // — and the case-insensitive contract diverged from the case-sensitive
  // narrowing in `asToolInputOneOf`, forcing a normalization shim at every
  // call site. Tightening to PascalCase-only aligns both layers and lets
  // the SDK contract be the single source of truth.
  it("matches PascalCase 'Task' only", () => {
    expect(isSubagentDispatch("Task")).toBe(true);
    expect(isSubagentDispatch("TASK")).toBe(false);
    expect(isSubagentDispatch("task")).toBe(false);
    expect(isSubagentDispatch("tAsK")).toBe(false);
  });

  it("matches PascalCase 'Agent' only", () => {
    expect(isSubagentDispatch("Agent")).toBe(true);
    expect(isSubagentDispatch("AGENT")).toBe(false);
    expect(isSubagentDispatch("agent")).toBe(false);
  });

  it("rejects other tool names", () => {
    expect(isSubagentDispatch("Read")).toBe(false);
    expect(isSubagentDispatch("Bash")).toBe(false);
    expect(isSubagentDispatch("agentic")).toBe(false);
    expect(isSubagentDispatch("")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isSubagentDispatch(null)).toBe(false);
    expect(isSubagentDispatch(undefined)).toBe(false);
    expect(isSubagentDispatch(42)).toBe(false);
    expect(isSubagentDispatch({ name: "Task" })).toBe(false);
  });
});

const TOOL_ID = "toolu_TEST_PARENT";

function assistantWithToolUse(
  id: string,
  name: string,
): ClaudeStreamMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input: {} }] },
  } as unknown as ClaudeStreamMessage;
}

function userMessage(parentToolUseId: string | null | undefined): ClaudeStreamMessage {
  return {
    type: "user",
    parent_tool_use_id: parentToolUseId,
    message: { content: [{ type: "text", text: "hello" }] },
  } as unknown as ClaudeStreamMessage;
}

describe("isSubagentPrompt", () => {
  it("returns false for non-user messages", () => {
    const all = [assistantWithToolUse(TOOL_ID, "Task")];
    expect(isSubagentPrompt(all[0]!, all)).toBe(false);
  });

  it("returns false when parent_tool_use_id is missing", () => {
    const msg = userMessage(undefined);
    expect(isSubagentPrompt(msg, [msg])).toBe(false);
  });

  it("returns false when parent_tool_use_id is null", () => {
    const msg = userMessage(null);
    expect(isSubagentPrompt(msg, [msg])).toBe(false);
  });

  it("returns false when parent_tool_use_id is empty string", () => {
    const msg = userMessage("");
    expect(isSubagentPrompt(msg, [msg])).toBe(false);
  });

  it("returns true when parent matches a Task tool_use", () => {
    const parent = assistantWithToolUse(TOOL_ID, "Task");
    const msg = userMessage(TOOL_ID);
    expect(isSubagentPrompt(msg, [parent, msg])).toBe(true);
  });

  it("returns true when parent matches an Agent tool_use", () => {
    const parent = assistantWithToolUse(TOOL_ID, "Agent");
    const msg = userMessage(TOOL_ID);
    expect(isSubagentPrompt(msg, [parent, msg])).toBe(true);
  });

  it("returns false when parent_tool_use_id matches a non-subagent tool", () => {
    const parent = assistantWithToolUse(TOOL_ID, "Read");
    const msg = userMessage(TOOL_ID);
    expect(isSubagentPrompt(msg, [parent, msg])).toBe(false);
  });

  it("returns false when no assistant message has matching id", () => {
    const parent = assistantWithToolUse("other_id", "Task");
    const msg = userMessage(TOOL_ID);
    expect(isSubagentPrompt(msg, [parent, msg])).toBe(false);
  });

  it("ignores assistant messages without array content", () => {
    const weird = {
      type: "assistant",
      message: { content: "not-an-array" },
    } as unknown as ClaudeStreamMessage;
    const msg = userMessage(TOOL_ID);
    expect(isSubagentPrompt(msg, [weird, msg])).toBe(false);
  });

  it("ignores assistant messages without a message object", () => {
    const weird = { type: "assistant" } as unknown as ClaudeStreamMessage;
    const msg = userMessage(TOOL_ID);
    expect(isSubagentPrompt(msg, [weird, msg])).toBe(false);
  });
});
