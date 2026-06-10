/**
 * Authoritative JsonlNode['kind'] catalog post-refactor (Phase 4 + 5).
 * These are the only kinds reachable by classifyJsonlLine:
 *
 *   ai-title
 *   assistant
 *   attachment
 *   cli-stream-init
 *   cli-stream-result
 *   file-history-snapshot
 *   last-prompt
 *   lifecycle
 *   permission-mode
 *   queue-operation
 *   rate-limit
 *   stream-event
 *   system
 *   unknown
 *   user
 */

import type { JsonlNode } from '@/types/jsonl';
import { isSubagentPrompt } from './subagentDispatch';
import { detectSkillInjection } from './skillDetection';
import { isSystemContextText } from './blockKind';

/**
 * Renderable in the chat feed for the purpose of "is this message
 * effectively a single-thing message?" decisions. Mirrors the predicate
 * `compactGrouping.ts` uses for the same question — kept inline here so
 * the two files stay independent. (An empty text block or signature-only
 * thinking block doesn't count.)
 */
function isRenderableBlockLocal(b: unknown): boolean {
  if (!b || typeof b !== 'object') return false;
  const block = b as { type?: string; text?: unknown; thinking?: unknown };
  if (block.type === 'tool_use' || block.type === 'tool_result' || block.type === 'image') return true;
  if (block.type === 'text') {
    const t = typeof block.text === 'string' ? block.text.trim() : '';
    return t.length > 0;
  }
  if (block.type === 'thinking') {
    const t = typeof block.thinking === 'string' ? block.thinking.trim() : '';
    return t.length > 0;
  }
  return false;
}

function hasMatchingToolResult(toolUseId: string, allMessages: JsonlNode[]): boolean {
  for (const m of allMessages) {
    if (m.kind !== 'user') continue;
    const content = (m.raw as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const block = b as { type?: string; tool_use_id?: string };
      if (block?.type === 'tool_result' && block.tool_use_id === toolUseId) return true;
    }
  }
  return false;
}

function findMatchingToolUseName(
  toolUseId: string,
  allMessages: JsonlNode[],
): string | undefined {
  for (const m of allMessages) {
    if (m.kind !== 'assistant') continue;
    const content = (m.raw as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const block = b as { type?: string; id?: string; name?: string };
      if (block?.type === 'tool_use' && block.id === toolUseId) return block.name;
    }
  }
  return undefined;
}

/**
 * Classify a stream node as a single "standalone" rendering kind — i.e. a
 * message whose rendered output is exactly one kind card and can be filtered
 * as a unit in compact mode.
 *
 * Returns null for messages whose rendering depends on per-content-block
 * logic (assistant/user messages with mixed text / tool_use / tool_result).
 * Those are intentionally left to the StreamMessage renderer; dropping them
 * wholesale would hide unrelated content.
 *
 * The kind IDs returned here must match entries in DEFAULT_KINDS.
 */
export function classifyStandaloneKind(
  msg: JsonlNode,
  allMessages: JsonlNode[],
): string | null {
  // permission_request comes through as 'unknown' kind with raw.type === 'permission_request'
  if (msg.kind === 'unknown') {
    const raw = msg.raw as { type?: string; tool_name?: string; subtype?: string };
    if (raw.type === 'permission_request') {
      const toolName = (raw as { tool_name?: string }).tool_name;
      // The live AskUserQuestion prompt keeps its own kind (distinct accent/icon
      // from the generic Bash/Read permission prompt). NOTE: only the *answered*
      // card is recategorized under the agent origin (see
      // AnsweredAskUserQuestionCard) — the live interactive prompt is left as-is.
      if (toolName === 'AskUserQuestion') return 'permission.askUserQuestion';
      return 'permission.request';
    }
    if (raw.type === 'summary') {
      const s = raw as { summary?: string; leafUuid?: string };
      if (s.summary && s.leafUuid) return 'summary.compaction';
    }
    return null;
  }

  // AskUserQuestion: elevate the answered Q+A card to a first-order
  // chat-feed message (no surrounding assistant bubble) when the wrapping
  // assistant message would only contain the tool_use, and hide the user
  // message that just carries the matching tool_result. Only fires once
  // the tool_result has actually landed — while the user is mid-answer
  // the live `permission.askUserQuestion` prompt is the visible card and
  // the in-bubble fallback handles the assistant message normally.
  //
  // The two returned IDs (`tool.askUserQuestion.answered` and `.result`)
  // are internal dispatch sentinels for StreamMessage's short-circuit —
  // they intentionally do NOT have entries in the v2 catalog because
  // the matching branch returns AnsweredAskUserQuestionCard / null before
  // the MessageFrame chrome lookup runs.
  if (msg.kind === 'assistant') {
    const content = (msg.raw as { message?: { content?: unknown } }).message?.content;
    if (Array.isArray(content)) {
      const renderable = content.filter(isRenderableBlockLocal);
      if (renderable.length === 1) {
        const only = renderable[0] as { type?: string; name?: string; id?: string };
        if (
          only.type === 'tool_use'
          && typeof only.name === 'string'
          && only.name.toLowerCase() === 'askuserquestion'
          && typeof only.id === 'string'
          && hasMatchingToolResult(only.id, allMessages)
        ) {
          return 'tool.askUserQuestion.answered';
        }
      }
    }
  }

  if (msg.kind === 'user') {
    const content = (msg.raw as { message?: { content?: unknown } }).message?.content;
    if (Array.isArray(content)) {
      const renderable = content.filter(isRenderableBlockLocal);
      if (renderable.length === 1) {
        const only = renderable[0] as { type?: string; tool_use_id?: string };
        if (only.type === 'tool_result' && typeof only.tool_use_id === 'string') {
          const name = findMatchingToolUseName(only.tool_use_id, allMessages);
          if (typeof name === 'string' && name.toLowerCase() === 'askuserquestion') {
            return 'tool.askUserQuestion.answered.result';
          }
        }
      }
    }
  }

  if (msg.kind === 'attachment') {
    const att = (msg.raw as { attachment?: { type?: string } }).attachment;
    const subtype = att?.type;
    if (typeof subtype === 'string' && subtype.length > 0) {
      return `attachment.${subtype}`;
    }
    return 'attachment.unknown';
  }

  if (msg.kind === 'system') {
    const subtype = msg.subtype as string;
    if (subtype === 'notification') {
      const raw = msg.raw as { notification_type?: string };
      const t = raw.notification_type ?? 'info';
      if (/error/i.test(t)) return 'system.notification.error';
      if (t === 'stop') return 'system.notification.stop';
      if (/warn/i.test(t)) return 'system.notification.warn';
      return 'system.notification.info';
    }
    if (subtype === 'hook_started') return 'system.hook_started';
    if (subtype === 'hook_response') return 'system.hook_response';
    if (subtype === 'permission_denied') return 'system.permission_denied';
    if (subtype === 'user_prompt_submit') return 'system.userPromptSubmit';
    if (subtype === 'away_summary') return 'system.away_summary';
    // Fallback: any other system subtype renders as the unknown gray inline strip.
    return 'system.unknown';
  }

  // Bookkeeping JSONL kinds: the kind id equals the node kind. Returning it
  // here (rather than null) lets compact-grouping read each kind's registry
  // `hiddenInCompact` flag instead of force-sweeping them into a hidden group.
  if (
    msg.kind === 'permission-mode' ||
    msg.kind === 'last-prompt' ||
    msg.kind === 'ai-title' ||
    msg.kind === 'queue-operation' ||
    msg.kind === 'file-history-snapshot'
  ) {
    return msg.kind;
  }

  // Synthetic control-change markers (effort/model/permission) → control.<x>.
  if (msg.kind === 'control-change') {
    return `control.${msg.control}`;
  }

  // Subagent prompts: user-role messages synthesized by the Task/Agent tool.
  if (isSubagentPrompt(msg, allMessages)) {
    return 'user.subagentPrompt';
  }

  // Skill-injected user messages.
  if (detectSkillInjection(msg, allMessages)) {
    return 'user.skillInjection';
  }

  // Slash-command echoes / local-command stdout — the CLI wraps these in
  // <command-name>/<local-command-stdout> tags inside a user-role text
  // block, so detection is a content match on the whole message.
  if (msg.kind === 'user') {
    const content = (msg.raw as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return null;

    let text = '';
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        text += block.text;
      }
    }
    if (text.includes('<command-name>')) return 'user.command';
    if (text.includes('<local-command-stdout>')) return 'user.commandOutput';

    // System-context user messages.
    if (content.length > 0) {
      let sawText = false;
      let allSystemContext = true;
      for (const block of content) {
        if (block?.type === 'text') {
          sawText = true;
          if (!isSystemContextText(typeof block.text === 'string' ? block.text : '')) {
            allSystemContext = false;
            break;
          }
        } else if (block?.type === 'image') {
          allSystemContext = false;
          break;
        }
      }
      if (sawText && allSystemContext) return 'user.systemContext';
    }
  }

  return null;
}
