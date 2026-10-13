import type { JsonlNode } from '@/types/jsonl';
import { createRowLookupCache, rowLookups, type RowLookups } from '@/lib/rowLookups';

/** A row's lookups against `messages`, for rendering one StreamMessage in a test. */
export function lookupsFor(message: JsonlNode, messages: readonly JsonlNode[]): RowLookups {
  return rowLookups(message, messages, createRowLookupCache());
}
