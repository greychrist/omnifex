import { describe, it, expect } from "vitest";
import {
  createDefaultConfig,
  getByPath,
  conditionsMatch,
  resolveMessageStyle,
  resolveKind,
  type MessageRenderingConfig,
  type MatchCondition,
  type Override,
} from "../messageRenderingConfig";
import type { JsonlNode } from "@/types/jsonl";

// A message is matched against its `.raw` JSON. These helpers fabricate the
// minimal raw shapes the classifier produces, plus the synthetic `$kind` /
// `$category` paths.
function node(raw: unknown): JsonlNode {
  return { raw } as unknown as JsonlNode;
}

describe("getByPath", () => {
  const raw = {
    type: "system",
    subtype: "notification",
    notification_type: "error",
    message: {
      stop_reason: "end_turn",
      content: [
        { type: "tool_use", name: "Bash" },
        { type: "text", text: "hi" },
      ],
    },
    attachment: { type: "todo_reminder" },
  };

  it("reads a top-level key", () => {
    expect(getByPath(raw, "type")).toEqual(["system"]);
    expect(getByPath(raw, "subtype")).toEqual(["notification"]);
    expect(getByPath(raw, "notification_type")).toEqual(["error"]);
  });

  it("reads a nested dotted path", () => {
    expect(getByPath(raw, "message.stop_reason")).toEqual(["end_turn"]);
    expect(getByPath(raw, "attachment.type")).toEqual(["todo_reminder"]);
  });

  it("expands [] to every array element for the remainder of the path", () => {
    expect(getByPath(raw, "message.content[].type").sort()).toEqual(["text", "tool_use"]);
    expect(getByPath(raw, "message.content[].name")).toEqual(["Bash", undefined]);
  });

  it("returns an empty set when a path segment is missing", () => {
    expect(getByPath(raw, "nope")).toEqual([undefined]);
    expect(getByPath(raw, "message.nope.deeper")).toEqual([]);
    expect(getByPath(raw, "missing[].x")).toEqual([]);
  });

  it("tolerates a null/undefined root", () => {
    expect(getByPath(undefined, "type")).toEqual([]);
    expect(getByPath(null, "type")).toEqual([]);
  });
});

describe("conditionsMatch", () => {
  const msg = node({
    type: "system",
    subtype: "notification",
    notification_type: "error",
    message: {
      stop_reason: "end_turn",
      content: [{ type: "tool_use", name: "Bash" }],
    },
  });
  const cond = (path: string, op: MatchCondition["op"], value: MatchCondition["value"]): MatchCondition =>
    ({ path, op, value });

  it("empty match matches everything", () => {
    expect(conditionsMatch([], msg, "system.notification.error", "system")).toBe(true);
  });

  it("eq compares the typed JSON value strictly", () => {
    expect(conditionsMatch([cond("subtype", "eq", "notification")], msg, "x", "system")).toBe(true);
    expect(conditionsMatch([cond("notification_type", "eq", "error")], msg, "x", "system")).toBe(true);
    expect(conditionsMatch([cond("notification_type", "eq", "warn")], msg, "x", "system")).toBe(false);
  });

  it("ANDs all conditions", () => {
    const m = [cond("subtype", "eq", "notification"), cond("notification_type", "eq", "error")];
    expect(conditionsMatch(m, msg, "x", "system")).toBe(true);
    const m2 = [cond("subtype", "eq", "notification"), cond("notification_type", "eq", "warn")];
    expect(conditionsMatch(m2, msg, "x", "system")).toBe(false);
  });

  it("matches any array element for a []-path condition", () => {
    expect(conditionsMatch([cond("message.content[].type", "eq", "tool_use")], msg, "x", "agent")).toBe(true);
    expect(conditionsMatch([cond("message.content[].name", "eq", "Bash")], msg, "x", "agent")).toBe(true);
    expect(conditionsMatch([cond("message.content[].name", "eq", "Edit")], msg, "x", "agent")).toBe(false);
  });

  it("resolves $kind and $category synthetic paths", () => {
    expect(conditionsMatch([cond("$kind", "eq", "assistant.tool-use")], msg, "assistant.tool-use", "agent")).toBe(true);
    expect(conditionsMatch([cond("$kind", "eq", "assistant.text")], msg, "assistant.tool-use", "agent")).toBe(false);
    expect(conditionsMatch([cond("$category", "eq", "agent")], msg, "assistant.tool-use", "agent")).toBe(true);
  });

  it("contains is a case-sensitive substring on string values", () => {
    expect(conditionsMatch([cond("notification_type", "contains", "rr")], msg, "x", "system")).toBe(true);
    expect(conditionsMatch([cond("notification_type", "contains", "RR")], msg, "x", "system")).toBe(false);
  });

  it("regex uses RegExp.test on string values and tolerates bad patterns", () => {
    expect(conditionsMatch([cond("notification_type", "regex", "^err")], msg, "x", "system")).toBe(true);
    expect(conditionsMatch([cond("notification_type", "regex", "warn$")], msg, "x", "system")).toBe(false);
    // Invalid regex never throws — it simply doesn't match.
    expect(conditionsMatch([cond("notification_type", "regex", "(")], msg, "x", "system")).toBe(false);
  });

  it("typed (non-string) literals compare by value", () => {
    const m = node({ message: { stop_reason: null }, flag: true, n: 3 });
    expect(conditionsMatch([cond("message.stop_reason", "eq", null)], m, "x", "agent")).toBe(true);
    expect(conditionsMatch([cond("flag", "eq", true)], m, "x", "agent")).toBe(true);
    expect(conditionsMatch([cond("n", "eq", 3)], m, "x", "agent")).toBe(true);
    expect(conditionsMatch([cond("n", "eq", 4)], m, "x", "agent")).toBe(false);
  });
});

describe("resolveMessageStyle", () => {
  function withOverrides(overrides: Override[]): MessageRenderingConfig {
    return { ...createDefaultConfig(), overrides };
  }

  it("returns the category base when no override matches", () => {
    const cfg = withOverrides([]);
    const s = resolveMessageStyle(cfg, node({ type: "assistant" }), "assistant.text");
    expect(s.headerLabel).toBe("Claude"); // agent category
    expect(s.alignment).toBe("left");
  });

  it("applies a matching override's sparse style over the base", () => {
    const cfg = withOverrides([
      { id: "tool", label: "Tool", category: "agent", match: [{ path: "$kind", op: "eq", value: "assistant.tool-use" }], style: { accentColor: "info", icon: "Terminal" } },
    ]);
    const s = resolveMessageStyle(cfg, node({ type: "assistant" }), "assistant.tool-use");
    expect(s.accentColor).toBe("info");
    expect(s.icon).toBe("Terminal");
    expect(s.headerLabel).toBe("Claude"); // inherited from agent base
  });

  it("only applies overrides scoped to the kind's category", () => {
    const cfg = withOverrides([
      { id: "x", label: "x", category: "user", match: [], style: { accentColor: "pink" } },
    ]);
    // assistant.tool-use is in the agent category — the user-scoped override is ignored.
    const s = resolveMessageStyle(cfg, node({ type: "assistant" }), "assistant.tool-use");
    expect(s.accentColor).toBe("primary"); // agent base, not pink
  });

  it("cascades per-field: the more specific (more conditions) override wins per field", () => {
    const bash = node({ message: { content: [{ type: "tool_use", name: "Bash" }] } });
    const cfg = withOverrides([
      { id: "generic", label: "tool", category: "agent", match: [{ path: "message.content[].type", op: "eq", value: "tool_use" }], style: { accentColor: "info", icon: "Terminal" } },
      { id: "bash", label: "bash", category: "agent", match: [
        { path: "message.content[].type", op: "eq", value: "tool_use" },
        { path: "message.content[].name", op: "eq", value: "Bash" },
      ], style: { accentColor: "green" } },
    ]);
    const s = resolveMessageStyle(cfg, bash, "assistant.tool-use");
    // bash (2 conditions) beats generic (1) for accentColor…
    expect(s.accentColor).toBe("green");
    // …but generic's icon still applies since bash doesn't set it.
    expect(s.icon).toBe("Terminal");
  });

  it("breaks equal-specificity ties by array (definition) order — later wins", () => {
    const cfg = withOverrides([
      { id: "a", label: "a", category: "agent", match: [{ path: "$kind", op: "eq", value: "assistant.text" }], style: { accentColor: "red" } },
      { id: "b", label: "b", category: "agent", match: [{ path: "$kind", op: "eq", value: "assistant.text" }], style: { accentColor: "blue" } },
    ]);
    const s = resolveMessageStyle(cfg, node({ type: "assistant" }), "assistant.text");
    expect(s.accentColor).toBe("blue");
  });

  it("resolveKind is resolveMessageStyle with no overrides (category base only)", () => {
    const cfg = createDefaultConfig();
    const base = resolveKind(cfg, "assistant.tool-use");
    // resolveKind ignores overrides entirely — it is the pure category base.
    expect(base.accentColor).toBe("primary");
    expect(base.icon).toBe("Bot");
  });
});
