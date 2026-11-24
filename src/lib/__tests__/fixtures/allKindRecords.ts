import type { JsonlNode } from '@/types/jsonl';
import type { ModernItem } from '@/lib/modernGrouping';

export { ALL_KIND_RECORDS, KIND_OF_RECORD, NOT_A_RECORD } from '@/lib/sampleTranscript';

export function idOf(n: JsonlNode | undefined): string | null {
  if (!n) return null;
  const uuid = (n as { raw?: { uuid?: unknown } }).raw?.uuid;
  return typeof uuid === 'string' ? uuid : `${n.kind}@${(n as { receivedAt?: string }).receivedAt ?? ''}`;
}

export function drawnUuids(items: ModernItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const i = item as { node?: JsonlNode; nodes?: JsonlNode[]; resultNode?: JsonlNode; summaryNode?: JsonlNode };
    for (const n of [i.node, ...(i.nodes ?? []), i.resultNode, i.summaryNode]) {
      const id = idOf(n);
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

