import type { MatchCondition } from "@/lib/messageRenderingConfig";

/** Render a condition value the way it reads in a rule: strings quoted, other
 *  JSON literals bare. */
export function formatMatchValue(value: MatchCondition["value"]): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** Render a single condition as a readable `path op value` row. */
export function formatCondition(c: MatchCondition): string {
  return `${c.path} ${c.op} ${formatMatchValue(c.value)}`;
}

export interface ExamplePath {
  path: string;
  value: MatchCondition["value"];
}

/**
 * Flatten an example raw message into the set of clickable leaf paths the match
 * dialog offers. Arrays collapse to a `key[]` segment ("any element"), nested
 * objects use dotted paths, and only scalar leaves (string / number / boolean /
 * null) become suggestions — each paired with the example's value so a click
 * can prefill a `path eq <value>` condition.
 */
export function flattenExamplePaths(root: unknown, prefix = ""): ExamplePath[] {
  if (Array.isArray(root)) {
    // Represent the array as `<prefix>[]` (any element) and descend into the
    // first element to surface its fields. Real messages carry a single block
    // per tool call in practice, so element 0 is representative.
    return root.length > 0 ? flattenExamplePaths(root[0], `${prefix}[]`) : [];
  }
  if (root !== null && typeof root === "object") {
    const out: ExamplePath[] = [];
    for (const [k, v] of Object.entries(root)) {
      out.push(...flattenExamplePaths(v, prefix ? `${prefix}.${k}` : k));
    }
    return out;
  }
  if (typeof root === "string" || typeof root === "number" || typeof root === "boolean" || root === null) {
    return prefix ? [{ path: prefix, value: root }] : [];
  }
  return [];
}
