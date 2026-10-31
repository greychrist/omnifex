/**
 * The Modern format's "Done" line: the answer that ends a turn, marked with
 * what the turn took. Modern's counterpart to Compact's green
 * `assistant.text.endTurn` card.
 *
 * "Ends a turn" is positional — the last item before the next prompt, or the
 * last item of a turn that is no longer running — not `stop_reason`: under
 * --include-partial-messages the committed record carries `stop_reason: null`
 * (see StreamMessage's note on the completion card).
 *
 * The figures are read from the records, never estimated: a turn without a
 * prompt has no duration, one whose records carry no usage has no cost.
 */
import type { JsonlNode } from '@/types/jsonl';
import type { ModernItem } from './modernGrouping';
import { isMainAssistant } from './sessionDerivedState';
import { computeMessageCost, type UsageTokens } from './pricing';
import { shortDuration } from './modernSteps';

export interface TurnFooter {
  /** Prompt to answer; null without a prompt to measure from. */
  ms: number | null;
  /** Tool calls the turn's runs made. */
  steps: number;
  /** Main-thread spend at shipped prices; null when nothing carried usage. */
  usd: number | null;
}

function timeOf(node: JsonlNode): number | null {
  const t = Date.parse((node as { receivedAt?: string | null }).receivedAt ?? '');
  return Number.isFinite(t) ? t : null;
}

/** The turn's main-thread spend. The CLI writes one record per content block,
 *  each repeating the message's usage, so a message is priced once. */
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

/** The footer for each answer that ends a turn, by item key. */
export function modernTurnFooters(
  items: ModernItem[],
  /** The whole transcript, which the cost is read from. */
  messages: JsonlNode[],
  /** The last turn is still running, so its last answer may not be its last. */
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
    const next = items[i + 1];
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

/** "Done · 4m 12s · 23 steps · $0.38" — whichever figures there are. */
export function turnFooterText(footer: TurnFooter, showCost: boolean): string {
  const parts = ['Done'];
  if (footer.ms !== null && footer.ms >= 1000) parts.push(shortDuration(footer.ms));
  if (footer.steps > 0) parts.push(`${footer.steps} step${footer.steps === 1 ? '' : 's'}`);
  if (showCost && footer.usd !== null) parts.push(`$${footer.usd.toFixed(2)}`);
  return parts.join(' · ');
}

/** `next`, with each unchanged footer replaced by its previous object, so an
 *  appended record does not break every finished answer's memo. */
export function keepUnchangedFooters(
  prev: Map<string, TurnFooter>,
  next: Map<string, TurnFooter>,
): Map<string, TurnFooter> {
  const out = new Map<string, TurnFooter>();
  for (const [key, footer] of next) {
    const old = prev.get(key);
    out.set(key, old && old.ms === footer.ms && old.steps === footer.steps && old.usd === footer.usd ? old : footer);
  }
  return out;
}
