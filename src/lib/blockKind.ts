import type { JsonlNode } from '@/types/jsonl';
import type { MessageContentBlock } from '@/types/claudeStream';
import type { MessageRenderingConfig } from './messageRenderingConfig';
import { resolveMessageStyle } from './messageRenderingConfig';

/**
 * Matches the literal prefix Claude Code prepends when surfacing hook
 * output back to the model as a user text message. Examples:
 *   "Stop hook feedback:"
 *   "PreToolUse hook feedback:"
 *   "PostToolUse hook feedback:"
 *   "UserPromptSubmit hook feedback:"
 *   "SubagentStop hook feedback:"
 *   "Notification hook feedback:"
 *   "SessionEnd hook feedback:"
 *   "SessionStart hook additional context:"
 *
 * Anchored at start (`^`) so user-typed text mentioning these phrases
 * mid-message doesn't get reclassified. The leading event name is
 * a single capitalized identifier; the suffix is one of the two
 * conventional verbs Claude Code uses.
 */
const HOOK_FEEDBACK_PREFIX = /^[A-Z][A-Za-z]* hook (feedback|additional context):/;

/**
 * True when a piece of user-role text content is actually a system injection
 * (hook feedback, a `<system-reminder>` block, a skill-load preamble) rather
 * than something the user typed. Used both by per-block classification and
 * by whole-message classification so the renderer treats these consistently
 * — without this, hook-feedback-only user messages fall through to the
 * `user.prompt` card and look like the user said them.
 *
 * The hook-feedback regex is anchored at the start so user text that
 * mentions phrases like "Stop hook feedback:" mid-message does not get
 * misclassified.
 */
export function isSystemContextText(text: string): boolean {
  if (typeof text !== 'string') return false;
  if (text.includes('<system-reminder>')) return true;
  if (text.includes('Base directory for this skill:')) return true;
  if (HOOK_FEEDBACK_PREFIX.test(text.trimStart())) return true;
  return false;
}

/**
 * Derive a human label for a `user.systemContext` message from its content
 * (e.g. "Skill: Brainstorming Ideas Into Designs", "CLAUDE.md Context",
 * "System Reminder"). Pure — the caller decides whether a user-customized
 * config header should win over this derived value. Skill detection is
 * checked first because a skill body may itself mention CLAUDE.md.
 */
export function deriveSystemContextLabel(content: string): string {
  if (content.includes('Base directory for this skill:')) {
    const m = /# (.+)/.exec(content);
    return m ? `Skill: ${m[1]}` : 'Skill Loaded';
  }
  if (content.includes('CLAUDE.md')) return 'CLAUDE.md Context';
  if (content.includes('<system-reminder>')) return 'System Reminder';
  return 'System Context';
}

/**
 * Classify a single content block (text, tool_use, tool_result, thinking,
 * image) within its parent assistant or user node to a `MessageKindConfig`
 * id. This is the per-block analog of `classifyStandaloneKind` — the latter
 * classifies a whole message when it has a single matching shape; this one
 * classifies *each block* of a mixed-content message so the renderer can
 * apply per-block compact-mode hiding.
 *
 * Returns null when the block has no specific kind mapping (e.g. a plain
 * user `text` block — those are absorbed into whole-message classifications
 * like `user.prompt` instead of getting a per-block kind).
 */
export function classifyBlockKind(
  block: MessageContentBlock | null | undefined,
  parent: JsonlNode,
): string | null {
  if (!block || typeof block !== 'object') return null;
  const role = parent.kind;

  if (role === 'assistant') {
    if (block.type === 'text') {
      const text = block.text.trim();
      if (text.length === 0) return null;
      // A text block whose parent assistant message ended the turn cleanly
      // (end_turn) is the "execution completed" visual. Gets its own kind so
      // the catalog can give it distinct chrome (e.g. green accent, check
      // icon) without affecting mid-turn assistant text.
      const stop = (parent.raw as { message?: { stop_reason?: string | null } }).message?.stop_reason;
      if (stop === 'end_turn') return 'assistant.text.endTurn';
      return 'assistant.text';
    }
    if (block.type === 'thinking') {
      const text = block.thinking.trim();
      return text.length > 0 ? 'assistant.thinking' : null;
    }
    if (block.type === 'tool_use') {
      return 'assistant.tool-use';
    }
    // Anthropic-hosted server-side tools (code_execution, web_search,
    // web_fetch) emit `server_tool_use` blocks rather than `tool_use`.
    // The CLI doesn't currently surface these, but classify defensively
    // so a future CLI release doesn't drop them into the unknown-tool
    // catch-all.
    if (block.type === 'server_tool_use') {
      return 'assistant.serverToolUse';
    }
    return null;
  }

  if (role === 'user') {
    if (block.type === 'image') return 'user.image';
    if (block.type === 'tool_result') {
      // All tool_result blocks map to the single v2 catalog row `user.tool-result`.
      // The previous per-variant split (generic vs. systemReminder) has been
      // collapsed because the v2 catalog has a single row and per-variant
      // sub-IDs caused the renderer's `config.kinds[id]` lookup to miss.
      return 'user.tool-result';
    }
    // Server-side code-execution result blocks — paired with server_tool_use
    // above. Same defensive registration; the CLI surface doesn't emit
    // these today.
    if (
      block.type === 'bash_code_execution_tool_result' ||
      block.type === 'text_editor_code_execution_tool_result'
    ) {
      return 'tool.result.codeExecution';
    }
    if (block.type === 'text') {
      // Claude Code / the CLI surface hook output back to the model
      // as plain user text prefixed with "<HookEvent> hook feedback:"
      // (Stop / PreToolUse / PostToolUse / UserPromptSubmit / SubagentStop
      // / Notification / SessionEnd) or the "SessionStart hook additional
      // context:" variant. Also matches <system-reminder> blocks and
      // skill-load preambles. See `isSystemContextText`.
      if (isSystemContextText(block.text)) return 'user.systemContext';
      // Plain user text falls through to whole-message classification
      // (user.prompt / user.subagentPrompt / user.sdkSystemBracket).
      return null;
    }
    return null;
  }

  return null;
}

/**
 * True when the block's classified kind is marked `hiddenInCompact` in the
 * config (and the kind is not boundary-locked — defense in depth, since
 * mergeConfig already prevents that combination).
 */
export function isBlockHiddenInCompact(
  block: MessageContentBlock | null | undefined,
  parent: JsonlNode,
  config: MessageRenderingConfig,
): boolean {
  const id = classifyBlockKind(block, parent);
  if (!id) return false;
  const kind = resolveMessageStyle(config, parent, id);
  if (kind.compactBoundaryLocked) return false;
  return kind.hiddenInCompact;
}
