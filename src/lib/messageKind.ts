import type { ClaudeStreamMessage } from '@/types/claudeStream';
import { deriveSubagents } from './subagentStreams';
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

function hasMatchingToolResult(toolUseId: string, allMessages: ClaudeStreamMessage[]): boolean {
  for (const m of allMessages) {
    if (m.type !== 'user') continue;
    const content = (m as { message?: { content?: unknown } }).message?.content;
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
  allMessages: ClaudeStreamMessage[],
): string | undefined {
  for (const m of allMessages) {
    if (m.type !== 'assistant') continue;
    const content = (m as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const block = b as { type?: string; id?: string; name?: string };
      if (block?.type === 'tool_use' && block.id === toolUseId) return block.name;
    }
  }
  return undefined;
}

/**
 * Classify a stream message as a single "standalone" rendering kind — i.e. a
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
  msg: ClaudeStreamMessage,
  allMessages: ClaudeStreamMessage[],
): string | null {
  if (msg.type === 'permission_request') {
    // The built-in AskUserQuestion tool gets its own kind so it can carry a
    // distinct accent color from generic Bash/Read permission prompts. Both
    // travel on the same `permission_request` channel; the SDK puts the
    // tool name on `tool_name` (snake_case wire) which the reducer also
    // normalises onto the camelCase payload.
    const toolName = (msg as unknown as { tool_name?: string; toolName?: string }).tool_name
      ?? (msg as unknown as { toolName?: string }).toolName;
    if (toolName === 'AskUserQuestion') return 'permission.askUserQuestion';
    return 'permission.request';
  }

  if (msg.type === 'result') {
    const sub = msg.subtype;
    if (sub && /error/i.test(String(sub))) return 'result.error';
    // Sibling of result.success: when this turn ends with a still-running
    // subagent dispatch, the parent is genuinely "idle, awaiting wake-up"
    // rather than fully complete. The SDK does not distinguish these in the
    // result blob, so we look at message history before this result for any
    // subagent that has not yet returned.
    const idx = allMessages.indexOf(msg);
    const prior = idx >= 0 ? allMessages.slice(0, idx) : allMessages;
    if (deriveSubagents(prior).some((s) => s.status === 'running')) {
      return 'result.awaiting_background';
    }
    return 'result.success';
  }

  // Compaction summaries arrive as a synthetic "summary" type with a leafUuid.
  if (msg.type === 'summary' && msg.summary && msg.leafUuid) {
    return 'summary.compaction';
  }

  // AskUserQuestion: elevate the answered Q+A card to a first-order
  // chat-feed message (no surrounding assistant bubble) when the wrapping
  // assistant message would only contain the tool_use, and hide the user
  // message that just carries the matching tool_result. Only fires once
  // the tool_result has actually landed — while the user is mid-answer
  // the live `permission.askUserQuestion` prompt is the visible card and
  // the in-bubble fallback handles the assistant message normally.
  if (msg.type === 'assistant') {
    const content = (msg as { message?: { content?: unknown } }).message?.content;
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

  if (msg.type === 'user') {
    const content = (msg as { message?: { content?: unknown } }).message?.content;
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

  if (msg.type === 'system') {
    if (msg.subtype === 'init') return 'system.init';
    if (msg.subtype === 'notification') {
      const t = msg.notification_type ?? 'info';
      if (/error/i.test(t)) return 'system.notification.error';
      if (t === 'stop') return 'system.notification.stop';
      if (/warn/i.test(t)) return 'system.notification.warn';
      return 'system.notification.info';
    }
    if (msg.subtype === 'hook_started') return 'system.hook.started';
    if (msg.subtype === 'hook_response') return 'system.hook.response';
    // SDKPermissionDeniedMessage (auto-deny short-circuit) and the OmniFex
    // PermissionDenied hook synthetic both ride this subtype. Classify
    // both as one user-facing kind so the renderer can give them a
    // distinct accent instead of the generic gray system.unknown strip.
    if (msg.subtype === 'permission_denied') return 'system.permission_denied';
    // Legacy `user_prompt_submit` subtype check: this is a hook *event* name,
    // not an SDK message subtype (the SDK never emits a system message with
    // this subtype). Historical OmniFex JSONL may carry it; tolerate via a
    // permissive cast so the dedicated kind classification still wins.
    if ((msg as { subtype?: string }).subtype === 'user_prompt_submit')
      return 'system.userPromptSubmit';
    // Fallback: any other system subtype renders as the unknown gray inline
    // strip in StreamMessage and is now configurable as `system.unknown`.
    return 'system.unknown';
  }

  // Subagent prompts: user-role messages synthesized by the Task/Agent
  // tool. The strict check (parent_tool_use_id resolves to a Task/Agent
  // tool_use) avoids false positives on real user prompts whose
  // parent_tool_use_id is set by the CLI for conversation-tree chaining.
  if (isSubagentPrompt(msg, allMessages)) {
    return 'user.subagentPrompt';
  }

  // Skill-injected user messages: the SDK injects the SKILL.md body as a
  // user-role text message after the Skill tool runs. Detection looks at
  // the previous tool_result + the corresponding tool_use's name.
  if (detectSkillInjection(msg, allMessages)) {
    return 'user.skillInjection';
  }

  // Slash-command echoes / local-command stdout — the CLI wraps these in
  // <command-name>/<local-command-stdout> tags inside a user-role text
  // block, so detection is a content match on the whole message.
  if (msg.type === 'user') {
    const content: unknown = msg.message?.content as unknown;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          text += block.text;
        }
      }
    }
    if (text.includes('<command-name>')) return 'user.command';
    if (text.includes('<local-command-stdout>')) return 'user.commandOutput';

    // System-context user messages: the Agent SDK delivers hook output,
    // <system-reminder> injections, and skill-load preambles as synthetic
    // user-role text messages. Without this branch they fall through to
    // the StreamMessage `user.prompt` card and look like the user typed
    // them — including the stop-hook "You have N unfinished todo items"
    // feedback that prompted this classification. Only treat the whole
    // message as system context when *every* text block looks like a
    // system injection; mixed user-typed + appended-reminder messages
    // stay null and are handled by the per-block renderer.
    if (Array.isArray(content) && content.length > 0) {
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
          // Images imply a real user message.
          allSystemContext = false;
          break;
        }
      }
      if (sawText && allSystemContext) return 'user.systemContext';
    } else if (typeof content === 'string' && content.length > 0 && isSystemContextText(content)) {
      return 'user.systemContext';
    }
  }

  return null;
}

