/**
 * Reader for the CLI's pseudo-XML envelopes (`<command-name>`,
 * `<task-notification>`, …).
 *
 * These are flat, non-nested, never-escaped tag soups the CLI writes into a
 * text block — not real XML, so a parser is overkill and a per-tag regex is
 * the honest shape. This exists so the same regex is not re-typed per
 * envelope: the tag order and the set of tags present both vary by producer,
 * which is exactly what a single ordered regex gets wrong.
 */
export function tagText(text: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return match ? match[1].trim() : undefined;
}

/** `tagText` parsed as a base-10 integer; undefined when absent or unparseable. */
export function tagInt(text: string, name: string): number | undefined {
  const raw = tagText(text, name);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}
