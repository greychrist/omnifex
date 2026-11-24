// Keyed by node identity (`rowKeyOf`), so appending a record never re-keys the items before it.
import type { JsonlNode } from '@/types/jsonl';
import type { MessageRenderingConfig } from './messageRenderingConfig';
import { isMessageFullyHidden } from './recordVisibility';
import { isMainPrompt } from './transcriptStepper';
import { rowKeyOf } from './rowKey';
import { commandEnvelopeKind, isRecapCommandRecord, localCommandOutput, parseCommandEnvelope } from './commandEnvelope';
import { sessionWritesLostText } from './sessionWritesLost';
import { modernLineOf, type LineAccent, type ModernLine } from './modernLines';
import { originInjectedKind } from './messageKind';
import { formatTokens } from './contextPressure';
import { shortDuration } from './modernSteps';
/** The removed progress mod's tool: old transcripts still hold its calls, which are bookkeeping, not work. */
const LEGACY_PROGRESS_TOOL = 'mcp__omnifex__progress';

export type ToolStatus = 'pending' | 'done' | 'error';

export type WorkEntry =
  | {
      type: 'thinking';
      key: string;
      node: JsonlNode;
      text: string;
      ms: number | null;
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
      skillBody?: string;
    };

export type ModernItem =
  | {
      kind: 'prompt'; key: string; node: JsonlNode; text: string;
      images?: PromptImage[];
    }
  | { kind: 'text'; key: string; node: JsonlNode; text: string }
  | { kind: 'work'; key: string; entries: WorkEntry[]; nodes: JsonlNode[] }
  | { kind: 'question'; key: string; node: JsonlNode; input: Record<string, unknown>; resultNode?: JsonlNode }
  | { kind: 'plan'; key: string; node: JsonlNode; markdown: string; resultNode?: JsonlNode }
  | { kind: 'notice'; key: string; node: JsonlNode; tone: NoticeTone; text: string }
  | {
      kind: 'compaction'; key: string; node: JsonlNode;
      detail: string;
      summary?: string;
      summaryNode?: JsonlNode;
    }
  | { kind: 'recap'; key: string; node: JsonlNode; text: string }
  | { kind: 'instructions'; key: string; node: JsonlNode; files: InstructionFile[] }
  | { kind: 'line'; key: string; node: JsonlNode; line: ModernLine };

export interface PromptImage { src: string; mediaType: string }

export interface InstructionFile { path: string; scope: string | null }

export type NoticeTone = 'stop' | 'error' | 'warn' | 'info';

const STOP_TEXT = 'Response interrupted';

function noticeOf(node: JsonlNode): { tone: NoticeTone; text: string } | null {
  if (node.kind === 'user' && node.userKind === 'interrupt') return { tone: 'stop', text: STOP_TEXT };
  if (node.kind === 'system' && node.subtype === 'session_writes_lost') return { tone: 'error', text: sessionWritesLostText(node.raw) };
  if (node.kind !== 'system' || node.subtype !== 'notification') return null;
  const raw = node.raw as { notification_type?: string; title?: unknown; body?: unknown };
  const type = String(raw.notification_type ?? '');
  if (type === 'stop') return { tone: 'stop', text: STOP_TEXT };
  const tone: NoticeTone = type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'info';
  const parts = [raw.title, raw.body].filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return { tone, text: parts.join(' — ') || 'Notice' };
}

interface Block { type?: unknown; text?: string; thinking?: string; id?: string; [k: string]: unknown }

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

function plainText(node: JsonlNode): string {
  return contentOf(node).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n');
}

type PromptShape = Pick<Extract<ModernItem, { kind: 'prompt' }>, 'text' | 'images'>;

function promptOf(node: JsonlNode): PromptShape | null {
  if (node.kind !== 'user') return null;
  if (originInjectedKind(node.raw) !== null) return null;
  const text = plainText(node);
  const isEcho = commandEnvelopeKind(text) === 'echo';
  if (isEcho && (node.userKind === 'local-command' || isMainPrompt(node))) {
    const env = parseCommandEnvelope(text);
    if (!env) return null;
    return { text: env.args ? `${env.name} ${env.args}` : env.name };
  }
  if (!isMainPrompt(node)) return null;
  const blocks = contentOf(node);
  const images: PromptImage[] = [];
  for (const b of blocks) {
    if (b.type === 'text') continue;
    const source = b.source as { type?: unknown; media_type?: string; data?: string } | undefined;
    if (b.type !== 'image' || source?.type !== 'base64') return null;
    const mediaType = String(source.media_type ?? 'image/png');
    images.push({ src: `data:${mediaType};base64,${String(source.data ?? '')}`, mediaType });
  }
  if (/<command-(name|message)>|<local-command-/.test(text)) return null;
  if (!text.trim() && images.length === 0) return null;
  return images.length > 0 ? { text, images } : { text };
}

function recapOf(node: JsonlNode): string | null {
  if (node.kind !== 'system') return null;
  const content = (node.raw as { content?: unknown }).content;
  if (typeof content !== 'string') return null;
  if (node.subtype === 'away_summary') return content.trim() || null;
  if (node.subtype === 'local_command' && isRecapCommandRecord(node.raw)) return localCommandOutput(content).trim() || null;
  return null;
}

function instructionFilesOf(node: JsonlNode): InstructionFile[] | null {
  if (node.kind !== 'attachment') return null;
  const att = (node.raw as { attachment?: { type?: unknown; files?: unknown } }).attachment;
  if (att?.type !== 'instructions' || !Array.isArray(att.files)) return null;
  const files: InstructionFile[] = [];
  for (const f of att.files as { path?: unknown; type?: unknown }[]) {
    if (!f || typeof f.path !== 'string' || !f.path) continue;
    files.push({ path: f.path, scope: typeof f.type === 'string' && f.type ? f.type : null });
  }
  return files.length > 0 ? files : null;
}

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

function isAbsorbedResult(node: JsonlNode, claimed: Set<string>): boolean {
  if (node.kind !== 'user' || node.userKind !== 'tool-result') return false;
  const results = contentOf(node).filter((b) => b.type === 'tool_result');
  return results.length > 0 && results.every((b) => claimed.has(String(b.tool_use_id)));
}

export function buildModernItems(
  messages: JsonlNode[],
  config: MessageRenderingConfig,
  /** The whole transcript: the display filter drops tool-result rows. */
  allMessages: JsonlNode[] = messages,
  filtered = true,
): ModernItem[] {
  const hidden = (node: JsonlNode) => filtered && isMessageFullyHidden(node, messages, config);
  const results = new Map<string, { node: JsonlNode; text: string; error: boolean }>();
  for (const node of allMessages) {
    if (node.kind !== 'user') continue;
    for (const b of contentOf(node)) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        results.set(b.tool_use_id, { node, text: resultText(b.content), error: b.is_error === true });
      }
    }
  }

  const claimed = new Set<string>();
  for (const node of messages) {
    if (node.kind !== 'assistant') continue;
    for (const b of contentOf(node)) {
      if (b.type === 'tool_use' && typeof b.id === 'string') claimed.add(b.id);
    }
  }

  const items: ModernItem[] = [];
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
  // The thinking record lands when the thought ends, so the gap from the record before is its duration.
  let previousAt: number | null = null;
  const timeOf = (node: JsonlNode): number | null => {
    const t = Date.parse((node as { receivedAt?: string | null }).receivedAt ?? '');
    return Number.isFinite(t) ? t : null;
  };

  for (const node of messages) {
    const nodeKey = rowKeyOf(node);
    const startedAt = previousAt;
    previousAt = timeOf(node) ?? previousAt;

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
            if (b.name === LEGACY_PROGRESS_TOOL) return;
            const id = String(b.id ?? '');
            const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>;
            const res = results.get(id);
            if (CONVERSATION_TOOLS.has(b.name)) {
              // Until it is answered, the live card above the composer is the only copy.
              if (!res) return;
              closeWork();
              items.push(b.name === 'AskUserQuestion'
                ? { kind: 'question', key: `q-${key}`, node, input, resultNode: res?.node }
                : { kind: 'plan', key: `p-${key}`, node, markdown: String((input.plan as string | undefined) ?? ''), resultNode: res?.node });
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
      if (blocks.every((b) => b.type === 'thinking')) continue;
    }

    if (node.kind === 'system' && node.subtype === 'thinking_tokens') {
      const n = (node.raw as { estimated_tokens?: unknown }).estimated_tokens;
      if (typeof n === 'number') pendingTokens = n;
      continue;
    }

    // A re-invocation sends a preamble and the body, so both are kept.
    if (node.kind === 'user' && node.userKind === 'meta-skill') {
      const source = skillEntries.get(String((node.raw as { sourceToolUseID?: string }).sourceToolUseID ?? ''));
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
      if (!(notice.tone === 'stop' && last?.kind === 'notice' && last.tone === 'stop')) {
        items.push({ kind: 'notice', key: `n-${nodeKey}`, node, ...notice });
      }
      continue;
    }

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

    const files = instructionFilesOf(node);
    if (files !== null && !hidden(node)) {
      closeWork();
      items.push({ kind: 'instructions', key: `i-${nodeKey}`, node, files });
      continue;
    }

    const recap = recapOf(node);
    if (recap !== null && !hidden(node)) {
      closeWork();
      items.push({ kind: 'recap', key: `r-${nodeKey}`, node, text: recap });
      continue;
    }

    const prompt = promptOf(node);
    if (prompt !== null) {
      closeWork();
      items.push({ kind: 'prompt', key: `u-${nodeKey}`, node, ...prompt });
      continue;
    }

    if (hidden(node)) continue;
    closeWork();
    items.push({ kind: 'line', key: `l-${nodeKey}`, node, line: modernLineOf(node, messages, config) });
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
    case 'notice':
    case 'recap': return a.node === (b as typeof a).node && a.text === (b as typeof a).text;
    case 'question':
    case 'plan': return a.node === (b as typeof a).node && a.resultNode === (b as typeof a).resultNode;
    case 'prompt':
    case 'text': return a.node === (b as typeof a).node && a.text === (b as typeof a).text;
    case 'compaction': return a.node === (b as typeof a).node && a.summaryNode === (b as typeof a).summaryNode;
    case 'instructions': return a.node === (b as typeof a).node;
    // A line's look is resolved from config at build time, so a settings change must replace it.
    case 'line': return a.node === (b as typeof a).node && sameLine(a.line, (b as typeof a).line);
  }
}

function sameLine(a: ModernLine, b: ModernLine): boolean {
  return a.icon === b.icon && a.title === b.title && a.detail === b.detail && a.body === b.body
    && a.tone === b.tone && a.fold === b.fold && a.mono === b.mono
    && accentKey(a.accent) === accentKey(b.accent);
}

function accentKey(accent: LineAccent | undefined): string {
  if (!accent) return '';
  return accent.kind === 'css' ? `css:${accent.color}` : `model:${accent.model}`;
}

/** Without this, every row's memo breaks on each appended record: the whole-transcript re-render freeze. */
export function keepUnchangedItems(prev: ModernItem[], next: ModernItem[]): ModernItem[] {
  if (prev.length === 0) return next;
  const byKey = new Map(prev.map((item) => [item.key, item]));
  return next.map((item) => {
    const old = byKey.get(item.key);
    return old && sameItem(old, item) ? old : item;
  });
}
