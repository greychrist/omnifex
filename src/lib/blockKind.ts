import type { ClaudeStreamMessage } from '@/types/claudeStream';
import type { MessageRenderingConfig } from './messageRenderingConfig';

/**
 * Classify a single content block (text, tool_use, tool_result, thinking,
 * image) within its parent assistant or user message to a `MessageKindConfig`
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
  block: any,
  parent: ClaudeStreamMessage,
): string | null {
  if (!block || typeof block !== 'object') return null;
  const role = parent.type;

  if (role === 'assistant') {
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text.trim() : '';
      return text.length > 0 ? 'assistant.text' : null;
    }
    if (block.type === 'thinking') {
      const text = typeof block.thinking === 'string' ? block.thinking.trim() : '';
      return text.length > 0 ? 'assistant.thinking' : null;
    }
    if (block.type === 'tool_use') return 'assistant.toolUse';
    return null;
  }

  if (role === 'user') {
    if (block.type === 'image') return 'user.image';
    if (block.type === 'tool_result') {
      const inner = block.content;
      const innerText = typeof inner === 'string'
        ? inner
        : Array.isArray(inner)
          ? inner.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
          : '';
      if (innerText.includes('<system-reminder>')) return 'tool.result.systemReminder';
      return 'tool.result.generic';
    }
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (text.includes('<system-reminder>') || text.includes('Base directory for this skill:')) {
        return 'user.systemContext';
      }
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
  block: any,
  parent: ClaudeStreamMessage,
  config: MessageRenderingConfig,
): boolean {
  const id = classifyBlockKind(block, parent);
  if (!id) return false;
  const kind = config.kinds[id];
  if (!kind) return false;
  if (kind.compactBoundaryLocked) return false;
  return kind.hiddenInCompact === true;
}
