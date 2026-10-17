import type { JsonlNode } from '@/types/jsonl';

/**
 * A React key for a transcript row that follows the record, not its position.
 *
 * Rows used to be keyed by index. That holds while records are only appended,
 * but the CLI's stream `init` is inserted before the first user record — on
 * every process start, including the one after a /compact — and shifting every
 * index handed every row a different message, defeating each row's memo. On a
 * 12 MB transcript that re-rendered ~1,800 rows at once (2026-10-16).
 *
 * Keyed by object identity, because no field is unique on every node kind:
 * `uuid` is absent from stream frames and shared by a prompt echo and the CLI
 * record that replaces it. The store keeps node objects across updates, so the
 * identity is stable for exactly as long as the record is.
 */
const keys = new WeakMap<JsonlNode, string>();
let next = 0;

export function rowKeyOf(node: JsonlNode): string {
  let key = keys.get(node);
  if (key === undefined) {
    key = `r${next++}`;
    keys.set(node, key);
  }
  return key;
}
