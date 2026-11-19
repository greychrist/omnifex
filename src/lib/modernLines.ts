/**
 * What the Modern format draws for a record that is not conversation: one
 * Trace line, as the recap is — the kind's icon, a title, a short detail
 * beside it, and any longer text under the line's left rule (open, or folded
 * when it is long). Replaces the Compact card Modern used to borrow for every
 * record it did not model.
 *
 * The text is recordText.ts's, which Compact's cards read too, so the two
 * formats word a record the same. The icon is the kind's Appearance icon, so a
 * restyled kind keeps its icon here. Visibility is not decided here: the
 * caller drops a record Compact hides before asking.
 *
 * Every record gets a line (2026-11-18: the classic card is gone). Records
 * with nothing specific to say get the generic one: the kind's label, its
 * text, or its raw JSON folded. A line without an accent of its own, and not
 * an error or warning, wears its kind's color from Settings › Chats.
 */
import type { JsonlNode } from '@/types/jsonl';
import { KIND_REGISTRY, resolveKind, type IconName, type MessageRenderingConfig } from './messageRenderingConfig';
import { classifyStandaloneKind } from './messageKind';
import { bookkeepingText, progressText, rateLimitText, streamEnvelopeText, systemRecordText } from './recordText';
import { summariseContextAttachment } from './contextLedger';
import { commandEnvelopeKind, localCommandOutput } from './commandEnvelope';
import { EFFORT_OPTIONS, PERMISSION_OPTIONS } from './sessionDefaultOptions';
import { EFFORT_LEVELS, PERMISSION_MODES } from '@/components/ControlBar';

/** The color a change line wears: a CSS color, or a model whose Cost
 *  Report color depends on the theme (resolved where the line is drawn). */
export type LineAccent = { kind: 'css'; color: string } | { kind: 'model'; model: string };

export interface ModernLine {
  icon: IconName;
  title: string;
  /** Short text beside the title. */
  detail?: string;
  /** Longer text under the line's left rule. */
  body?: string;
  /** Body in mono, kept as written (command output, raw JSON). */
  mono?: boolean;
  /** Body hidden until the line is opened. */
  fold?: boolean;
  /** error: a failure, in the error red. warn: an unrecognized record, in the
   *  amber the context rail turns near its limit (amber-500). */
  tone?: 'error' | 'warn';
  /** The icon and title in this color, as an answered question wears its
   *  purple: a permission-mode, effort or model change, in the new value's. */
  accent?: LineAccent;
}

/** Past this, a text goes under the line instead of beside it. */
const DETAIL_MAX = 100;
/** Past this many lines, command output folds. */
const OPEN_LINES_MAX = 15;

/** A mode's picker label; `auto` has none there, an unknown mode is shown as sent. */
export function permissionModeLabel(mode: string): string {
  if (mode === 'auto') return 'Auto';
  return PERMISSION_OPTIONS.claude.find((o) => o.id === mode)?.label ?? mode;
}

/** The picker's Tailwind text color (`text-teal-600`) as the CSS variable
 *  Tailwind defines for it, so a line can wear it inline. */
function cssAccent(textClass: string | undefined): LineAccent | undefined {
  const name = textClass?.match(/^text-(.+)$/)?.[1];
  return name ? { kind: 'css', color: `var(--color-${name})` } : undefined;
}

function permissionAccent(mode: string): LineAccent | undefined {
  return cssAccent(PERMISSION_MODES.find((m) => m.id === mode)?.color);
}

function effortAccent(value: string): LineAccent | undefined {
  return cssAccent(EFFORT_LEVELS.find((l) => l.id === value)?.color);
}

function withAccent(line: ModernLine, accent: LineAccent | undefined): ModernLine {
  return accent ? { ...line, accent } : line;
}

function effortLabel(value: string): string {
  if (value === 'auto') return 'Auto';
  return EFFORT_OPTIONS.claude.find((o) => o.id === value)?.label ?? value;
}

/** "api_retry" → "Api retry": a subtype no kind names. */
function humanize(id: string): string {
  const s = id.replace(/[_-]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : id;
}

/** `text` beside the title when short and on one line, else folded under it. */
function withText(base: Omit<ModernLine, 'detail' | 'body' | 'fold'>, text: string): ModernLine {
  const t = text.trim();
  if (!t) return base;
  if (!t.includes('\n') && t.length <= DETAIL_MAX) return { ...base, detail: t };
  return { ...base, body: t, fold: true };
}

function commandOutputLine(icon: IconName, title: string, output: string): ModernLine {
  const body = output.replace(/^\n+|\s+$/g, '');
  if (!body) return { icon, title };
  return { icon, title, body, mono: true, fold: body.split('\n').length > OPEN_LINES_MAX };
}

/** System subtypes that report a failure: drawn in the error color. */
const ERROR_SUBTYPES = new Set(['api_error', 'error_during_execution', 'permission_denied']);

export function modernLineOf(
  node: JsonlNode,
  messages: readonly JsonlNode[],
  config: MessageRenderingConfig,
): ModernLine {
  const kindId = classifyStandaloneKind(node, messages) ?? blockKindOf(node);
  const style = resolveKind(config, kindId);
  const label = KIND_REGISTRY[kindId]?.label ?? humanize(kindId);
  const line = specificLine(node, kindId, style.icon, label) ?? genericLine(node, style.icon, label);
  return line.accent || line.tone ? line : { ...line, accent: { kind: 'css', color: style.accentColor } };
}

/** The kind of a record classifyStandaloneKind leaves to its content blocks. */
function blockKindOf(node: JsonlNode): string {
  if (node.kind === 'user') {
    const content = (node.raw as { message?: { content?: unknown } }).message?.content;
    const blocks = Array.isArray(content) ? (content as { type?: unknown }[]) : [];
    if (blocks.some((b) => b?.type === 'tool_result')) return 'user.tool-result';
    if (blocks.some((b) => b?.type === 'image')) return 'user.image';
    return 'user.prompt';
  }
  if (node.kind === 'assistant') return 'assistant.text';
  return 'unknown';
}

/** A record's readable text: its text blocks and tool-result text. */
function recordTextOf(node: JsonlNode): string {
  const content = ((node as { raw?: unknown }).raw as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as Record<string, unknown>[]) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    if (b?.type === 'tool_result') {
      const c = b.content;
      if (typeof c === 'string') parts.push(c);
      else if (Array.isArray(c)) {
        for (const x of c as Record<string, unknown>[]) if (x?.type === 'text' && typeof x.text === 'string') parts.push(x.text);
      }
    }
  }
  return parts.join('\n');
}

/** The line for a record nothing more specific describes. */
function genericLine(node: JsonlNode, icon: IconName, label: string): ModernLine {
  const text = recordTextOf(node);
  if (text.trim()) return withText({ icon, title: label }, text);
  const raw = (node as { raw?: unknown }).raw;
  return raw === undefined ? { icon, title: label } : { icon, title: label, body: JSON.stringify(raw, null, 2), mono: true, fold: true };
}

function specificLine(node: JsonlNode, kindId: string, icon: IconName, label: string): ModernLine | null {

  switch (node.kind) {
    case 'control-change':
      if (node.control === 'permission') return withAccent({ icon, title: 'Permission mode', detail: permissionModeLabel(node.value) }, permissionAccent(node.value));
      if (node.control === 'effort') return withAccent({ icon, title: 'Effort', detail: effortLabel(node.value) }, effortAccent(node.value));
      return { icon, title: 'Model', detail: node.value, accent: { kind: 'model', model: node.value } };

    case 'permission-mode': {
      const mode = node.raw.permissionMode;
      return typeof mode === 'string' && mode
        ? withAccent({ icon, title: 'Permission mode', detail: permissionModeLabel(mode) }, permissionAccent(mode))
        : { icon, title: 'Permission mode' };
    }

    case 'last-prompt':
    case 'ai-title':
    case 'custom-title':
    case 'queue-operation':
    case 'file-history-snapshot':
      return { icon, title: bookkeepingText(node) };

    case 'system': {
      const raw = node.raw as unknown as { content?: unknown; commandRun?: { command?: unknown } };
      if (node.subtype === 'local_command') {
        const command = typeof raw.commandRun?.command === 'string' ? `/${raw.commandRun.command}` : 'Command output';
        return commandOutputLine(icon, command, localCommandOutput(typeof raw.content === 'string' ? raw.content : ''));
      }
      // A subtype that shares the catch-all kind still has a name of its own
      // when the registry carries one (system.api_error).
      const title = kindId === 'system.unknown'
        ? KIND_REGISTRY[`system.${node.subtype}`]?.label ?? humanize(node.subtype)
        : label;
      return withText({ icon, title, ...(ERROR_SUBTYPES.has(node.subtype) ? { tone: 'error' as const } : {}) }, systemRecordText(node.raw, node.subtype));
    }

    case 'attachment': {
      const att = (node.raw as { attachment?: Record<string, unknown> }).attachment;
      const summary = summariseContextAttachment(att);
      return summary === null ? null : { icon, title: summary };
    }

    case 'rate-limit-event':
      return withText({ icon, title: label }, rateLimitText(node.raw.rate_limit_info));

    case 'progress': {
      const { variant, fields } = progressText(node.raw.data);
      return withText({ icon, title: variant ? `Progress · ${variant}` : 'Progress' }, fields);
    }

    case 'cli-stream-init':
    case 'cli-stream-result':
      return withText({ icon, title: label }, streamEnvelopeText(node));

    case 'unknown': {
      const raw = node.raw;
      // The live prompt is answered above the composer; its record is a line.
      if (raw.type === 'permission_request') {
        const tool = (raw as { tool_name?: unknown }).tool_name;
        return typeof tool === 'string' && tool ? { icon, title: label, detail: tool } : { icon, title: label };
      }
      if (raw.type === 'summary') {
        const summary = (raw as { summary?: unknown }).summary;
        return withText({ icon, title: label }, typeof summary === 'string' ? summary : '');
      }
      const base = typeof raw.type === 'string' ? raw.type : 'untyped record';
      const subtype = (raw as { subtype?: unknown }).subtype;
      const type = typeof subtype === 'string' && subtype ? `${base}.${subtype}` : base;
      return { icon, title: `Unrecognized record: ${type}`, body: JSON.stringify(raw, null, 2), mono: true, fold: true, tone: 'warn' };
    }

    case 'user': {
      // A built-in command's stdout in its pre-2.1.283 home, a user record.
      const content = (node.raw as { message?: { content?: unknown } }).message?.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((b) => ((b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('\n')
          : '';
      if (node.userKind === 'local-command' && commandEnvelopeKind(text) === 'output') {
        return commandOutputLine(icon, 'Command output', localCommandOutput(text));
      }
      return null;
    }

    default:
      return null;
  }
}
