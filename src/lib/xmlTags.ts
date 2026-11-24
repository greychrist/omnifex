// Per-tag regexes: tag order and the set of tags vary by producer, which one ordered regex gets wrong.
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
