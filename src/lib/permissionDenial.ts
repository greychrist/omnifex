/**
 * Denials the CLI makes without asking — the logic behind PermissionDeniedCard.
 *
 * In auto mode the CLI's safety classifier judges each action before any host
 * is consulted. A block never becomes a `can_use_tool` request: the model gets
 * an error tool_result and the host gets only a stream-only
 * `system/permission_denied`. There is nothing to approve in the moment, so the
 * card offers what the user used to type by hand: consent in chat, a standing
 * rule, or a mode that asks. When the classifier itself is down (a timeout, a
 * stage-2 error) the CLI fails closed; that is an outage, not a judgement, and
 * the card offers a plain retry.
 *
 * Wire text verified against CLI 2.1.284.
 */
import { formatFilePathForRule } from './rulePaths';
import type { JsonlNode } from '@/types/jsonl';

export type DenialKind = 'classifier-block' | 'classifier-unavailable' | 'other';

export interface DenialDescription {
  kind: DenialKind;
  /** The classifier's category, e.g. "Irreversible Local Destruction". */
  category: string | null;
}

const CATEGORY = /^\[([^\]]+)\]$/;
const BLOCK_TEXT = /^Permission for this action was denied by the Claude Code auto mode classifier\. Reason: \[([^\]]+)\]/;
const UNAVAILABLE_TEXT = /so auto mode cannot determine the safety of /;

/** The live `system/permission_denied` event. */
export function describeDenial(e: {
  decisionReasonType?: string;
  decisionReason?: string;
  message?: string;
}): DenialDescription {
  if (e.decisionReasonType !== 'classifier') return { kind: 'other', category: null };
  const category = CATEGORY.exec((e.decisionReason ?? '').trim())?.[1] ?? null;
  if (category) return { kind: 'classifier-block', category };
  return { kind: 'classifier-unavailable', category: null };
}

/**
 * The same denial read back from the tool_result the model was handed — the
 * only trace left after a reload, since the CLI never writes
 * permission_denied to the session file. Null for every other tool error.
 */
export function denialFromToolResult(text: string): DenialDescription | null {
  const block = BLOCK_TEXT.exec(text);
  if (block) return { kind: 'classifier-block', category: block[1] };
  if (UNAVAILABLE_TEXT.test(text)) return { kind: 'classifier-unavailable', category: null };
  return null;
}

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** A token that names a subcommand rather than an argument: no flag, no path. */
const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function dirname(p: string): string {
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** `git add -A` → `git add`; `rm -rf x` → `rm`. Leading `cd …` segments skipped. */
function commandPrefix(command: string): string | null {
  const segments = command.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  const judged = segments.find((s) => !/^cd(\s|$)/.test(s)) ?? segments[0];
  const [first, second] = (judged ?? '').split(/\s+/);
  if (!first) return null;
  return second && SUBCOMMAND.test(second) ? `${first} ${second}` : first;
}

/**
 * The rule "Always allow" starts from; the card lets the user edit it. File
 * tools become an `Edit(<folder>/**)` rule — the only file rule the CLI
 * matches (>= 2.1.210) — so a grant covers the next file in that folder too.
 */
export function suggestDenialRule(
  toolName: string,
  input: Record<string, unknown>,
  projectPath: string,
  homeDir: string,
): string | null {
  if (toolName === 'Bash') {
    const command = str(input.command);
    const prefix = command ? commandPrefix(command) : null;
    return prefix ? `Bash(${prefix}:*)` : null;
  }
  if (FILE_EDIT_TOOLS.has(toolName) || toolName === 'Read') {
    const fp = str(input.file_path) ?? str(input.notebook_path);
    if (!fp || !fp.startsWith('/')) return toolName === 'Read' ? 'Read' : 'Edit';
    const dir = formatFilePathForRule(dirname(fp), projectPath, homeDir).replace(/\/+$/, '');
    return `${toolName === 'Read' ? 'Read' : 'Edit'}(${dir}/**)`;
  }
  if (toolName === 'WebFetch') {
    try {
      return `WebFetch(domain:${new URL(String(input.url)).hostname})`;
    } catch {
      return 'WebFetch';
    }
  }
  return toolName || null;
}

/** One line naming the action: the command for Bash, else `Tool \`target\``. */
export function actionSummary(toolName: string, input: Record<string, unknown>): string {
  const command = str(input.command);
  if (toolName === 'Bash' && command) {
    const oneLine = command.replace(/\s+/g, ' ');
    return `\`${oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine}\``;
  }
  const target = str(input.file_path) ?? str(input.notebook_path) ?? str(input.url) ?? str(input.pattern);
  return target ? `${toolName} \`${target}\`` : toolName;
}

/**
 * What "Approve & retry" sends. The classifier reads consent from the
 * conversation, so an explicit approval in chat is what lets the retry through
 * — the same thing the user used to type by hand.
 */
export function retryPrompt(kind: DenialKind, toolName: string, input: Record<string, unknown>): string {
  const action = actionSummary(toolName, input);
  if (kind === 'classifier-unavailable') {
    return `The auto-mode safety check was unavailable. Please retry: ${action}`;
  }
  return `I approve this action — go ahead and retry it: ${action}`;
}

/** The tool call `toolUseId` — its name and input — searched newest first. */
export function findToolUse(
  nodes: readonly JsonlNode[],
  toolUseId: string,
): { name: string; input: Record<string, unknown> } | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.kind !== 'assistant') continue;
    const content = node.raw.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; id?: string; name?: string; input?: unknown }>) {
      if (block?.type === 'tool_use' && block.id === toolUseId) {
        const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
        return { name: block.name ?? 'tool', input };
      }
    }
  }
  return null;
}

/** Just the input of that call, or null when it is not in the transcript. */
export function findToolUseInput(nodes: readonly JsonlNode[], toolUseId: string): Record<string, unknown> | null {
  return findToolUse(nodes, toolUseId)?.input ?? null;
}

/** A tool_result's text: the string itself, or its text blocks joined. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: 'text'; text: string } =>
      !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text'
      && typeof (c as { text?: unknown }).text === 'string')
    .map((c) => c.text)
    .join('\n');
}

/** Whether a live `permission_denied` event for this call is in the transcript. */
export function hasLiveDenial(nodes: readonly JsonlNode[], toolUseId: string): boolean {
  return nodes.some(
    (n) => n.kind === 'system' && n.subtype === 'permission_denied'
      && (n.raw as { tool_use_id?: unknown }).tool_use_id === toolUseId,
  );
}

/** What "Always allow" sends once the rule is saved. */
export function ruleAddedPrompt(toolName: string, input: Record<string, unknown>): string {
  return `I added an allow rule for this — please retry it: ${actionSummary(toolName, input)}`;
}
