import type { JsonlNode } from '@/types/jsonl';
import type { MessageContentBlock } from '@/types/claudeStream';
import { toolResultHasImages } from './toolResultImages';

/** Anchored at the start so user text quoting these phrases mid-message is not reclassified. */
const HOOK_FEEDBACK_PREFIX = /^[A-Z][A-Za-z]* hook (feedback|additional context):/;

export function isSystemContextText(text: string): boolean {
  if (typeof text !== 'string') return false;
  if (text.includes('<system-reminder>')) return true;
  // Anchored at the start: quoted skill content mid-message is not a skill load.
  if (text.trimStart().startsWith('Base directory for this skill:')) return true;
  if (HOOK_FEEDBACK_PREFIX.test(text.trimStart())) return true;
  return false;
}

/** Skill is checked first: a skill body may itself mention CLAUDE.md. */
export function deriveSystemContextLabel(content: string): string {
  if (content.includes('Base directory for this skill:')) {
    const m = /# (.+)/.exec(content);
    return m ? `Skill: ${m[1]}` : 'Skill Loaded';
  }
  if (content.includes('CLAUDE.md')) return 'CLAUDE.md Context';
  if (content.includes('<system-reminder>')) return 'System Reminder';
  return 'System Context';
}

export function classifyBlockKind(
  block: MessageContentBlock | null | undefined,
  parent: JsonlNode,
): string | null {
  if (!block || typeof block !== 'object') return null;
  const role = parent.kind;

  if (role === 'assistant') {
    if (block.type === 'text') {
      const text = (block.text ?? '').trim();
      if (text.length === 0) return null;
      const stop = (parent.raw as { message?: { stop_reason?: string | null } }).message?.stop_reason;
      if (stop === 'end_turn') return 'assistant.text.endTurn';
      return 'assistant.text';
    }
    if (block.type === 'thinking') {
      const text = (block.thinking ?? '').trim();
      return text.length > 0 ? 'assistant.thinking' : null;
    }
    if (block.type === 'tool_use') {
      return 'assistant.tool-use';
    }
    // Server-side tools emit `server_tool_use`, not `tool_use`; the CLI does not surface them yet.
    if (block.type === 'server_tool_use') {
      return 'assistant.serverToolUse';
    }
    return null;
  }

  if (role === 'user') {
    if (block.type === 'image') return 'user.image';
    if (block.type === 'tool_result') {
      // Its own kind: ordinary tool output defaults to hidden in compact mode, which would bury screenshots.
      if (toolResultHasImages(block)) return 'user.tool-result.image';
      return 'user.tool-result';
    }
    if (
      block.type === 'bash_code_execution_tool_result' ||
      block.type === 'text_editor_code_execution_tool_result'
    ) {
      return 'tool.result.codeExecution';
    }
    if (block.type === 'text') {
      if (isSystemContextText(block.text ?? '')) return 'user.systemContext';
      return null;
    }
    return null;
  }

  return null;
}

