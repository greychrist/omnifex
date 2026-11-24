import type { JsonlNode } from '@/types/jsonl';

/**
 * Keyed by identity, not index: the stream's `init` is inserted before the first user record, which shifted every
 * index and defeated each row's memo. No field is unique on every node kind.
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
