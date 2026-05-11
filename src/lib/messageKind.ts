import type { ClaudeStreamMessage } from '@/types/claudeStream';
import { deriveSubagents } from './subagentStreams';
import { isSubagentPrompt } from './subagentDispatch';
import { detectSkillInjection } from './skillDetection';
import { isSystemContextText } from './blockKind';

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
    const sub = (msg as any).subtype;
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
  if ((msg as any).type === 'summary' && (msg as any).summary && (msg as any).leafUuid) {
    return 'summary.compaction';
  }

  if (msg.type === 'system') {
    if (msg.subtype === 'init') return 'system.init';
    if (msg.subtype === 'notification') {
      const t = String((msg as any).notification_type ?? 'info');
      if (/error/i.test(t)) return 'system.notification.error';
      if (t === 'stop') return 'system.notification.stop';
      if (/warn/i.test(t)) return 'system.notification.warn';
      return 'system.notification.info';
    }
    if (msg.subtype === 'hook_started') return 'system.hook.started';
    if (msg.subtype === 'hook_response') return 'system.hook.response';
    if (msg.subtype === 'user_prompt_submit') return 'system.userPromptSubmit';
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
    const content: unknown = msg.message?.content;
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

