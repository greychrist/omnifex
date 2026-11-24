// A latestInRun run ends only at a non-system message: status pings interleave with thinking_tokens.
// Collapse, never synthesize: deriveThinkingStatus reads the in-flight total off the tail.

import type { JsonlNode } from "@/types/jsonl";
import { classifyStandaloneKind } from "./messageKind";
import { KIND_REGISTRY, type ViewMode } from "./messageRenderingConfig";

export function collapseRepeats(
  messages: JsonlNode[],
  viewMode?: ViewMode,
): JsonlNode[] {
  const drop = new Set<number>();
  const pending = new Map<string, number>();
  const lastValue = new Map<string, string>();

  messages.forEach((msg, i) => {
    const isSystem = msg.kind === "system";
    if (!isSystem) pending.clear();
    if (!isSystem && msg.kind !== "permission-mode" && msg.kind !== "custom-title") return;
    const id = classifyStandaloneKind(msg, messages);
    const rule = id ? KIND_REGISTRY[id]?.collapse : undefined;
    if (!id || !rule) return;
    if (rule.mode === "onChange" && rule.onlyIn && !(viewMode && rule.onlyIn.includes(viewMode))) return;

    if (rule.mode === "latestInRun") {
      if (!isSystem) return;
      const prev = pending.get(id);
      if (prev !== undefined) drop.add(prev);
      pending.set(id, i);
      return;
    }

    const value = JSON.stringify((msg.raw as unknown as Record<string, unknown>)[rule.field] ?? null);
    if (lastValue.get(id) === value) drop.add(i);
    else lastValue.set(id, value);
  });

  return drop.size === 0 ? messages : messages.filter((_, i) => !drop.has(i));
}
