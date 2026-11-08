import { useEffect, useRef } from 'react';
import type { JsonlNode } from '@/types/jsonl';
import { slashModelResult } from '@/lib/sessionDerivedState';

/**
 * Keep `selectedModel` in step with a `/model` typed into the composer.
 *
 * The command goes to the CLI, which switches and writes its answer to the
 * transcript; OmniFex only ever learned the model from its own picker, so
 * the readout, the picker and a restart stayed on the old one. This watches
 * the transcript for that answer (slashModelResult) and reports it once.
 *
 * Only the LAST model-bearing record counts. In replayed history a `/model`
 * that later turns overrode is not the model the session is on, and firing
 * on it would undo what the resume restored from the same history.
 */
export function useSlashModelSync({ messages, onModel, onSavedAsDefault }: {
  messages: JsonlNode[];
  onModel: (model: string) => void;
  /** The CLI also rewrote the account's settings.json pin. */
  onSavedAsDefault?: () => void;
}): void {
  const seen = useRef<string | null>(null);
  useEffect(() => {
    const latest = latestModelEvent(messages);
    if (latest?.kind !== 'slash' || latest.key === seen.current) return;
    seen.current = latest.key;
    onModel(latest.model);
    if (latest.savedAsDefault) onSavedAsDefault?.();
  }, [messages, onModel, onSavedAsDefault]);
}

type ModelEvent =
  | { kind: 'turn' }
  | { kind: 'slash'; key: string; model: string; savedAsDefault: boolean };

function latestModelEvent(messages: JsonlNode[]): ModelEvent | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const node = messages[i];
    if (node.kind === 'assistant') {
      const raw = node.raw as { isSidechain?: boolean; message?: { model?: unknown } };
      if (!raw.isSidechain && typeof raw.message?.model === 'string') return { kind: 'turn' };
      continue;
    }
    const slash = slashModelResult(node);
    if (slash) {
      const uuid = (node as { raw?: { uuid?: unknown } }).raw?.uuid;
      return { kind: 'slash', key: typeof uuid === 'string' ? uuid : `${String(i)}:${slash.model}`, ...slash };
    }
  }
  return null;
}
