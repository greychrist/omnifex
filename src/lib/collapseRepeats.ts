// Folds repeats of a kind down to the rows worth drawing, per the kind's
// registry `collapse` rule (see CollapseRule in messageRenderingConfig.ts).
//
// Generic on purpose: a rule is data on the kind, and the user can turn it
// off per kind ("Show all"). Title rows are NOT handled here — their effective
// value is derived across two kinds (a custom title outranks the AI one), so
// that rule lives with the tab label's in sessionTitle.ts.
//
// Only `system` messages carry rules today, and a run is bounded by the first
// non-system message. Other system messages do not end a run: `status` pings
// interleave with `thinking_tokens` and must not split one burst in two.
//
// `thinking_tokens` is the rule's origin: `estimated_tokens` is the burst's
// running total, so the last ping states it and every earlier one is a
// strictly-worse duplicate. Collapsing rather than synthesising a summary
// keeps the output a faithful subset of what the CLI emitted, so
// `deriveThinkingStatus` can still read the in-flight total off the tail.

import type { JsonlNode } from "@/types/jsonl";
import { classifyStandaloneKind } from "./messageKind";
import { KIND_REGISTRY, resolveKind, type MessageRenderingConfig } from "./messageRenderingConfig";

export function collapseRepeats(
  messages: JsonlNode[],
  config: MessageRenderingConfig,
): JsonlNode[] {
  const drop = new Set<number>();
  // latestInRun: kind id → index of the newest message in the open run.
  const pending = new Map<string, number>();
  // onChange: kind id → the value on the kind's last kept row.
  const lastValue = new Map<string, string>();

  messages.forEach((msg, i) => {
    if (msg.kind !== "system") {
      pending.clear();
      return;
    }
    const id = classifyStandaloneKind(msg, messages);
    const rule = id ? KIND_REGISTRY[id]?.collapse : undefined;
    if (!id || !rule || resolveKind(config, id).collapseRepeats === false) return;

    if (rule.mode === "latestInRun") {
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
