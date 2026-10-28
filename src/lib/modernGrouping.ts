/**
 * The Modern chat format's grouping: displayable transcript rows → the units
 * Modern draws. See docs/superpowers/specs/2026-10-28-modern-chat-format-design.md.
 *
 * - A main prompt is a bubble.
 * - Assistant prose is a text item.
 * - Thinking and tool calls — with their results, and any records Compact
 *   would hide that land between them — fold into one `work` item, drawn as
 *   a Chain of Thought.
 * - AskUserQuestion and ExitPlanMode are conversation, not work: each is its
 *   own item and absorbs its result record.
 * - Notifications and the interrupt marker are `notice` lines; a stop shows
 *   once, whether as the live notification, the persisted marker, or both.
 * - Records Compact hides are left out — Modern has no hidden-events cards.
 *   The one it reads first: `thinking_tokens`, whose estimate goes on the
 *   thought it measured.
 * - Anything else is `other`, drawn as Compact draws a shown row.
 *
 * Pure, one pass, and keyed by node identity (`rowKeyOf`), so appending a
 * record never re-keys the items before it.
 */
import type { JsonlNode } from '@/types/jsonl';
import type { MessageRenderingConfig } from './messageRenderingConfig';
import { isMessageFullyHidden } from './compactGrouping';
import { isMainPrompt } from './transcriptStepper';
import { rowKeyOf } from './rowKey';
import { commandEnvelopeKind, parseCommandEnvelope } from './commandEnvelope';
import { originInjectedKind } from './messageKind';
import { formatTokens } from './contextPressure';
import { shortDuration } from './modernSteps';

export type ToolStatus = 'pending' | 'done' | 'error';

export type WorkEntry =
  | {
      type: 'thinking';
      key: string;
      node: JsonlNode;
      text: string;
      /** The CLI's thinking_duration_ms (live records), else the gap from the
       *  record before; null without either. */
      ms: number | null;
      /** The last thinking_tokens estimate before it (live only). */
      tokens: number | null;
    }
  | {
      type: 'tool';
      key: string;
      node: JsonlNode;
      id: string;
      name: string;
      input: Record<string, unknown>;
      status: ToolStatus;
      resultNode?: JsonlNode;
      resultText?: string;
      /** A Skill step's SKILL.md body — the CLI's companion record, folded in
       *  so the step, not a classic card beside it, is the skill's one row. */
      skillBody?: string;
    };

export type ModernItem =
  | {
      kind: 'prompt'; key: string; node: JsonlNode; text: string;
      /** Pasted images, as data URLs. */
      images?: PromptImage[];
      /** A slash command's echo: `text` is the command line. */
      command?: true;
    }
  | { kind: 'text'; key: string; node: JsonlNode; text: string }
  | { kind: 'work'; key: string; entries: WorkEntry[]; nodes: JsonlNode[] }
  | { kind: 'question'; key: string; node: JsonlNode; input: Record<string, unknown>; resultNode?: JsonlNode }
  | { kind: 'plan'; key: string; node: JsonlNode; markdown: string; resultNode?: JsonlNode }
  | { kind: 'notice'; key: string; node: JsonlNode; tone: NoticeTone; text: string }
  | {
      kind: 'compaction'; key: string; node: JsonlNode;
      /** "manual · 777k → 27k tokens · 1m 10s", from the boundary. */
      detail: string;
      /** The recap the CLI wrote after it. */
      summary?: string;
      summaryNode?: JsonlNode;
    }
  | { kind: 'other'; key: string; node: JsonlNode };

export interface PromptImage { src: string; mediaType: string }

export type NoticeTone = 'stop' | 'error' | 'warn' | 'info';

/** A stop reads the same live (notification) and reloaded (marker). */
const STOP_TEXT = 'Response interrupted';

function noticeOf(node: JsonlNode): { tone: NoticeTone; text: string } | null {
  if (node.kind === 'user' && node.userKind === 'interrupt') return { tone: 'stop', text: STOP_TEXT };
  if (node.kind !== 'system' || node.subtype !== 'notification') return null;
  const raw = node.raw as { notification_type?: unknown; title?: unknown; body?: unknown };
  const type = String(raw.notification_type ?? '');
  if (type === 'stop') return { tone: 'stop', text: STOP_TEXT };
  const tone: NoticeTone = type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'info';
  const parts = [raw.title, raw.body].filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return { tone, text: parts.join(' — ') || 'Notice' };
}

interface Block { type?: unknown; [k: string]: unknown }

function contentOf(node: JsonlNode): Block[] {
  const c = (node as { raw?: { message?: { content?: unknown } } }).raw?.message?.content;
  return Array.isArray(c) ? (c as Block[]) : [];
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && (b as Block).type === 'text' ? String((b as Block).text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

const CONVERSATION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** A record's text blocks, joined. Ingress (normalizeMessage) makes
 *  content an array. */
function plainText(node: JsonlNode): string {
  return contentOf(node).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n');
}

type PromptShape = Pick<Extract<ModernItem, { kind: 'prompt' }>, 'text' | 'images' | 'command'>;

/**
 * What the bubble draws for a user record: a typed prompt (text, pasted
 * images), or a slash command's echo as its command line. Null for anything
 * else, which Modern draws as Compact does.
 */
function promptOf(node: JsonlNode): PromptShape | null {
  if (node.kind !== 'user') return null;
  // A task notification or coordinator message: injected, not typed. Left
  // to the rules every format shares (Compact hides it by default).
  if (originInjectedKind(node.raw) !== null) return null;
  const text = plainText(node);
  const isEcho = commandEnvelopeKind(text) === 'echo';
  if (isEcho && (node.userKind === 'local-command' || isMainPrompt(node))) {
    const env = parseCommandEnvelope(text);
    if (!env) return null;
    return { text: env.args ? `${env.name} ${env.args}` : env.name, command: true };
  }
  if (!isMainPrompt(node)) return null;
  const blocks = contentOf(node);
  const images: PromptImage[] = [];
  for (const b of blocks) {
    if (b.type === 'text') continue;
    const source = b.source as { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
    if (b.type !== 'image' || source?.type !== 'base64') return null;
    const mediaType = String(source.media_type ?? 'image/png');
    images.push({ src: `data:${mediaType};base64,${String(source.data ?? '')}`, mediaType });
  }
  if (/<command-(name|message)>|<local-command-/.test(text)) return null;
  if (!text.trim() && images.length === 0) return null;
  return images.length > 0 ? { text, images } : { text };
}

/** The boundary's figures, as the classic card writes them, minus its title. */
function compactionDetail(node: JsonlNode): string {
  const meta = ((node as { raw?: unknown }).raw as { compactMetadata?: { trigger?: unknown; preTokens?: unknown; postTokens?: unknown; durationMs?: unknown } } | undefined)?.compactMetadata ?? {};
  const parts: string[] = [];
  if (typeof meta.trigger === 'string' && meta.trigger) parts.push(meta.trigger);
  if (typeof meta.preTokens === 'number' && typeof meta.postTokens === 'number') {
    parts.push(`${formatTokens(meta.preTokens)} → ${formatTokens(meta.postTokens)} tokens`);
  }
  if (typeof meta.durationMs === 'number') parts.push(shortDuration(meta.durationMs));
  return parts.join(' · ');
}

/** A tool-result record whose every result belongs to a tool use we drew. */
function isAbsorbedResult(node: JsonlNode, claimed: Set<string>): boolean {
  if (node.kind !== 'user' || node.userKind !== 'tool-result') return false;
  const results = contentOf(node).filter((b) => b.type === 'tool_result');
  return results.length > 0 && results.every((b) => claimed.has(String(b.tool_use_id)));
}

export function buildModernItems(
  messages: JsonlNode[],
  config: MessageRenderingConfig,
  /** The whole transcript, for pairing tools with results: the display
   *  filter drops tool-result rows, which other formats reach by lookup. */
  allMessages: JsonlNode[] = messages,
): ModernItem[] {
  // Every tool result, by the tool use it answers.
  const results = new Map<string, { node: JsonlNode; text: string; error: boolean }>();
  for (const node of allMessages) {
    if (node.kind !== 'user') continue;
    for (const b of contentOf(node)) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        results.set(b.tool_use_id, { node, text: resultText(b.content), error: b.is_error === true });
      }
    }
  }

  // Tool uses an item draws, so their result records are not drawn again.
  const claimed = new Set<string>();
  for (const node of messages) {
    if (node.kind !== 'assistant') continue;
    for (const b of contentOf(node)) {
      if (b.type === 'tool_use' && typeof b.id === 'string') claimed.add(b.id);
    }
  }

  const items: ModernItem[] = [];
  // `as` keeps TypeScript from narrowing this to `null` for good: the
  // closures below reassign it, which flow analysis does not follow.
  let work = null as Extract<ModernItem, { kind: 'work' }> | null;
  let pendingTokens: number | null = null;
  const skillEntries = new Map<string, { entry: Extract<WorkEntry, { type: 'tool' }>; work: Extract<ModernItem, { kind: 'work' }> }>();

  const closeWork = () => { work = null; };
  const openWork = (key: string) => {
    if (!work) {
      work = { kind: 'work', key: `w-${key}`, entries: [], nodes: [] };
      items.push(work);
    }
    return work;
  };
  // The thinking record lands when the thought ends, so the gap from the
  // record before it is how long it took.
  let previousAt: number | null = null;
  const timeOf = (node: JsonlNode): number | null => {
    const t = Date.parse((node as { receivedAt?: string | null }).receivedAt ?? '');
    return Number.isFinite(t) ? t : null;
  };

  for (const node of messages) {
    const nodeKey = rowKeyOf(node);
    const startedAt = previousAt;
    previousAt = timeOf(node) ?? previousAt;

    // Results of tools drawn elsewhere: attach to the run they belong to.
    if (isAbsorbedResult(node, claimed)) {
      if (work && !work.nodes.includes(node)) work.nodes.push(node);
      continue;
    }

    if (node.kind === 'assistant') {
      const blocks = contentOf(node);
      const drawn = blocks.some((b) =>
        (b.type === 'thinking' && String(b.thinking ?? '').trim())
        || (b.type === 'text' && String(b.text ?? '').trim())
        || b.type === 'tool_use');
      if (drawn) {
        blocks.forEach((b, i) => {
          const key = `${nodeKey}-${i}`;
          if (b.type === 'thinking') {
            const text = String(b.thinking ?? '');
            if (!text.trim()) return;
            const w = openWork(key);
            const endedAt = timeOf(node);
            const own = (node.raw as { thinking_duration_ms?: unknown }).thinking_duration_ms;
            const ms = typeof own === 'number'
              ? own
              : startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null;
            w.entries.push({ type: 'thinking', key, node, text, ms, tokens: pendingTokens });
            pendingTokens = null;
            if (!w.nodes.includes(node)) w.nodes.push(node);
          } else if (b.type === 'text') {
            const text = String(b.text ?? '');
            if (!text.trim()) return;
            closeWork();
            items.push({ kind: 'text', key: `t-${key}`, node, text });
          } else if (b.type === 'tool_use' && typeof b.name === 'string') {
            const id = String(b.id ?? '');
            const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>;
            const res = results.get(id);
            if (CONVERSATION_TOOLS.has(b.name)) {
              // Until it is answered, the live card above the composer is the
              // only copy — Compact draws these only once the result lands.
              if (!res) return;
              closeWork();
              items.push(b.name === 'AskUserQuestion'
                ? { kind: 'question', key: `q-${key}`, node, input, resultNode: res?.node }
                : { kind: 'plan', key: `p-${key}`, node, markdown: String(input.plan ?? ''), resultNode: res?.node });
              return;
            }
            const w = openWork(key);
            const entry: Extract<WorkEntry, { type: 'tool' }> = {
              type: 'tool', key, node, id, name: b.name, input,
              status: res === undefined ? 'pending' : res.error ? 'error' : 'done',
              resultNode: res?.node,
              resultText: res?.text,
            };
            w.entries.push(entry);
            if (b.name === 'Skill') skillEntries.set(id, { entry, work: w });
            if (!w.nodes.includes(node)) w.nodes.push(node);
            if (res && !w.nodes.includes(res.node)) w.nodes.push(res.node);
          }
        });
        continue;
      }
      // A redacted, signature-only thinking record has nothing to draw;
      // Compact drops these too. Any other block type (server tools, images)
      // falls through and is drawn as Compact draws it.
      if (blocks.every((b) => b.type === 'thinking')) continue;
    }

    // A thought's token estimate: kept for the thought, never a row.
    if (node.kind === 'system' && node.subtype === 'thinking_tokens') {
      const n = (node.raw as { estimated_tokens?: unknown }).estimated_tokens;
      if (typeof n === 'number') pendingTokens = n;
      continue;
    }

    // A skill's body: the CLI names the Skill call it belongs to. A
    // re-invocation sends a preamble and the body, so both are kept.
    if (node.kind === 'user' && node.userKind === 'meta-skill') {
      const source = skillEntries.get(String((node.raw as { sourceToolUseID?: unknown }).sourceToolUseID ?? ''));
      if (source) {
        const body = plainText(node);
        source.entry.skillBody = source.entry.skillBody ? `${source.entry.skillBody}\n\n${body}` : body;
        if (!source.work.nodes.includes(node)) source.work.nodes.push(node);
        continue;
      }
    }

    const notice = noticeOf(node);
    if (notice) {
      closeWork();
      const last = items[items.length - 1];
      // One stop, whichever of notification and marker arrive.
      if (!(notice.tone === 'stop' && last?.kind === 'notice' && last.tone === 'stop')) {
        items.push({ kind: 'notice', key: `n-${nodeKey}`, node, ...notice });
      }
      continue;
    }

    // A compaction is one line: the boundary, with the recap folded in.
    if (node.kind === 'system' && node.subtype === 'compact_boundary') {
      closeWork();
      items.push({ kind: 'compaction', key: `c-${nodeKey}`, node, detail: compactionDetail(node) });
      continue;
    }
    if (node.kind === 'user' && node.userKind === 'compact-summary') {
      closeWork();
      const last = items[items.length - 1];
      const summary = plainText(node);
      if (last?.kind === 'compaction' && !last.summaryNode) {
        items[items.length - 1] = { ...last, summary, summaryNode: node };
      } else {
        items.push({ kind: 'compaction', key: `c-${nodeKey}`, node, detail: '', summary, summaryNode: node });
      }
      continue;
    }

    const prompt = promptOf(node);
    if (prompt !== null) {
      closeWork();
      items.push({ kind: 'prompt', key: `u-${nodeKey}`, node, ...prompt });
      continue;
    }

    // Hidden in Compact: left out. Anything else is drawn as Compact draws it.
    if (isMessageFullyHidden(node, messages, config)) continue;
    closeWork();
    items.push({ kind: 'other', key: `o-${nodeKey}`, node });
  }
  return items;
}

function sameEntries(a: WorkEntry[], b: WorkEntry[]): boolean {
  return a.length === b.length && a.every((x, i) => {
    const y = b[i];
    if (x.type !== y.type || x.key !== y.key) return false;
    if (x.type === 'tool' && y.type === 'tool') return x.node === y.node && x.resultNode === y.resultNode && x.status === y.status && x.skillBody === y.skillBody;
    if (x.type === 'thinking' && y.type === 'thinking') return x.node === y.node && x.text === y.text && x.ms === y.ms && x.tokens === y.tokens;
    return false;
  });
}

function sameItem(a: ModernItem, b: ModernItem): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  switch (a.kind) {
    case 'work': return b.kind === 'work' && sameEntries(a.entries, b.entries);
    case 'notice': return a.node === (b as typeof a).node && a.text === (b as typeof a).text;
    case 'question':
    case 'plan': return a.node === (b as typeof a).node && a.resultNode === (b as typeof a).resultNode;
    case 'prompt':
    case 'text': return a.node === (b as typeof a).node && a.text === (b as typeof a).text;
    case 'compaction': return a.node === (b as typeof a).node && a.summaryNode === (b as typeof a).summaryNode;
    case 'other': return a.node === (b as typeof a).node;
  }
}

/**
 * `next`, with every item that is unchanged since `prev` replaced by its
 * previous object. Grouping rebuilds every item on each appended record;
 * without this, every row's memo would break on every record — the
 * one-record-re-renders-the-whole-transcript freeze this app has had before.
 */
export function keepUnchangedItems(prev: ModernItem[], next: ModernItem[]): ModernItem[] {
  if (prev.length === 0) return next;
  const byKey = new Map(prev.map((item) => [item.key, item]));
  return next.map((item) => {
    const old = byKey.get(item.key);
    return old && sameItem(old, item) ? old : item;
  });
}
