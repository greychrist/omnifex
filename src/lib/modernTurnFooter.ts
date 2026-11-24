// "Ends a turn" is positional, not `stop_reason`: under --include-partial-messages the committed record has `stop_reason: null`.
import type { JsonlNode } from '@/types/jsonl';
import type { ModernItem } from './modernGrouping';
import { isMainAssistant } from './sessionDerivedState';
import { computeMessageCost, type UsageTokens } from './pricing';
import { shortDuration } from './modernSteps';

export interface TurnFooter {
  ms: number | null;
  steps: number;
  usd: number | null;
}

function timeOf(node: JsonlNode): number | null {
  const t = Date.parse((node as { receivedAt?: string | null }).receivedAt ?? '');
  return Number.isFinite(t) ? t : null;
}

/** The CLI writes one record per content block, each repeating the message's usage, so a message is priced once. */
function turnCost(messages: JsonlNode[], from: number, to: number): number | null {
  const seen = new Set<string>();
  let usd: number | null = null;
  for (let i = Math.max(from, 0); i <= to; i++) {
    const node = messages[i];
    if (!isMainAssistant(node)) continue;
    const raw = node.raw as { requestId?: string; message?: { id?: string; model?: string; usage?: UsageTokens } };
    const usage = raw.message?.usage;
    if (!usage) continue;
    const key = raw.requestId ?? raw.message?.id;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    usd = (usd ?? 0) + computeMessageCost(raw.message?.model ?? '', usage).usd;
  }
  return usd;
}

export function modernTurnFooters(
  items: ModernItem[],
  messages: JsonlNode[],
  running: boolean,
): Map<string, TurnFooter> {
  const footers = new Map<string, TurnFooter>();
  const indexOf = new Map<JsonlNode, number>();
  messages.forEach((node, i) => indexOf.set(node, i));

  let promptNode: JsonlNode | null = null;
  let steps = 0;
  items.forEach((item, i) => {
    if (item.kind === 'prompt') {
      promptNode = item.node;
      steps = 0;
      return;
    }
    if (item.kind === 'work') steps += item.entries.filter((e) => e.type === 'tool').length;
    if (item.kind !== 'text') return;
    // /compact writes its marker before the command's prompt, so look past it.
    let j = i + 1;
    while (items[j]?.kind === 'compaction') j++;
    const next = items[j];
    const endsTurn = next ? next.kind === 'prompt' : !running;
    if (!endsTurn) return;
    const started = promptNode ? timeOf(promptNode) : null;
    const ended = timeOf(item.node);
    const from = promptNode ? (indexOf.get(promptNode) ?? -1) + 1 : 0;
    const to = indexOf.get(item.node) ?? -1;
    footers.set(item.key, {
      ms: started !== null && ended !== null ? Math.max(0, ended - started) : null,
      steps,
      usd: to >= 0 ? turnCost(messages, from, to) : null,
    });
  });
  return footers;
}

export function turnFooterText(footer: TurnFooter, showCost: boolean): string {
  const parts = ['Done'];
  if (footer.ms !== null && footer.ms >= 1000) parts.push(shortDuration(footer.ms));
  if (footer.steps > 0) parts.push(`${footer.steps} step${footer.steps === 1 ? '' : 's'}`);
  if (showCost && footer.usd !== null) parts.push(`$${footer.usd.toFixed(2)}`);
  return parts.join(' · ');
}

export function keepUnchangedFooters(
  prev: Map<string, TurnFooter>,
  next: Map<string, TurnFooter>,
): Map<string, TurnFooter> {
  const out = new Map<string, TurnFooter>();
  for (const [key, footer] of next) {
    const old = prev.get(key);
    out.set(key, old?.ms === footer.ms && old.steps === footer.steps && old.usd === footer.usd ? old : footer);
  }
  return out;
}
