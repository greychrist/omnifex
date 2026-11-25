import type { JsonlNode } from '@/types/jsonl';
import { isSubagentPrompt } from './subagentDispatch';
import { transcriptIndex } from './transcriptIndex';
import { detectSkillInjection } from './skillDetection';
import { isSystemContextText } from './blockKind';
import { commandEnvelopeKind, isRecapCommandRecord } from './commandEnvelope';
import { isCliSidechannelRecord } from './cliSidechannelRecords';
import { isTaskLifecycleMarker } from './subagentEvents';

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

function hasMatchingToolResult(toolUseId: string, allMessages: readonly JsonlNode[]): boolean {
  return transcriptIndex(allMessages).toolResults.has(toolUseId);
}

function findMatchingToolUseName(
  toolUseId: string,
  allMessages: readonly JsonlNode[],
): string | undefined {
  return transcriptIndex(allMessages).toolUses.get(toolUseId)?.name;
}

/** Only `origin.kind` task-notification / coordinator / peer are injected; `human`, absent or unknown fall to the content rules. */
export function originInjectedKind(raw: unknown): string | null {
  const kind = (raw as { origin?: { kind?: unknown } })?.origin?.kind;
  if (kind === 'task-notification') return 'user.taskNotification';
  if (kind === 'coordinator') return 'user.coordinatorMessage';
  if (kind === 'peer') return 'user.peerMessage';
  return null;
}

const STREAM_BOOKKEEPING_SUBTYPES: ReadonlySet<string> = new Set([
  'background_tasks_changed',
  'dev_intent',
  'per_turn_effort_changed',
  'elicitation_complete',
  'session_metadata',
  'session_title_changed',
  'ui_status',
  'ui_invalidate',
  'ui_focus',
  'ui_panes',
  'ui_placed',
  'ui_scroll',
  'ui_notify',
  'ui_notify_cancel',
  'commands_changed',
  'permission_check_status',
  'status',
]);

const MOD_LINE_SUBTYPES: ReadonlySet<string> = new Set(['ui_log', 'ui_toast']);

export function classifyStandaloneKind(
  msg: JsonlNode,
  allMessages: readonly JsonlNode[],
): string | null {
  if (msg.kind === 'unknown') {
    const raw = msg.raw as { type?: string; tool_name?: string; subtype?: string };
    if (raw.type === 'permission_request') {
      const toolName = (raw as { tool_name?: string }).tool_name;
      if (toolName === 'AskUserQuestion') return 'permission.askUserQuestion';
      return 'permission.request';
    }
    if (raw.type === 'summary') {
      const s = raw as { summary?: string; leafUuid?: string };
      if (s.summary && s.leafUuid) return 'summary.compaction';
    }
    if (isCliSidechannelRecord(raw)) return 'cli-state';
    if (isTaskLifecycleMarker(raw)) return 'task-lifecycle';
    if (raw.type === 'command_lifecycle') return 'queue-lifecycle';
    return null;
  }

  // `tool.askUserQuestion.answered*` are StreamMessage dispatch sentinels, deliberately not in KIND_REGISTRY.
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
    if (subtype === 'hook_progress') return 'system.hook_progress';
    if (subtype === 'permission_denied') return 'system.permission_denied';
    if (subtype === 'thinking_tokens') return 'system.thinking_tokens';
    if (subtype === 'user_prompt_submit') return 'system.userPromptSubmit';
    if (subtype === 'away_summary') return 'system.away_summary';
    if (subtype === 'feedback_draft_queued') return 'system.feedback_draft_queued';
    if (STREAM_BOOKKEEPING_SUBTYPES.has(subtype)) return `system.${subtype}`;
    if (MOD_LINE_SUBTYPES.has(subtype)) return `system.${subtype}`;
    // CLI 2.1.283+ writes slash-command stdout here; older transcripts carry it as user.commandOutput.
    if (subtype === 'local_command') {
      return isRecapCommandRecord(msg.raw) ? 'system.away_summary' : 'system.local_command';
    }
    if (subtype === 'session_writes_lost') return 'system.api_error';
    if (subtype === 'stop_hook_summary') return 'system.stop_hook_summary';
    if (subtype === 'compact_boundary') return 'system.compact_boundary';
    return 'system.unknown';
  }

  if (msg.kind === 'rate-limit-event') {
    return 'system.rate_limit';
  }

  if (msg.kind === 'progress') return 'system.progress';

  if (msg.kind === 'cli-stream-init') return 'system.init';
  if (msg.kind === 'cli-stream-result') return 'system.result';

  if (
    msg.kind === 'permission-mode' ||
    msg.kind === 'last-prompt' ||
    msg.kind === 'ai-title' ||
    msg.kind === 'custom-title' ||
    msg.kind === 'queue-operation' ||
    msg.kind === 'file-history-snapshot'
  ) {
    return msg.kind;
  }

  if (msg.kind === 'control-change') {
    return `control.${msg.control}`;
  }

  // The CLI's origin stamp beats any inference from text, so this precedes the content rules.
  if (msg.kind === 'user') {
    const injected = originInjectedKind(msg.raw);
    if (injected) return injected;
  }

  if (isSubagentPrompt(msg, allMessages)) {
    return 'user.subagentPrompt';
  }

  if (detectSkillInjection(msg, allMessages)) {
    return 'user.skillInjection';
  }

  if (msg.kind === 'user') {
    const content = (msg.raw as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return null;

    let text = '';
    for (const block of content as ({ type?: unknown; text?: unknown } | null)[]) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        text += block.text;
      }
    }
    // Same test the classifier keys 'local-command' off, so renderer and derivation never disagree.
    const envelope = commandEnvelopeKind(text);
    if (envelope === 'echo') return 'user.command';
    if (envelope === 'output') return 'user.commandOutput';

    if (content.length > 0) {
      let sawText = false;
      let allSystemContext = true;
      for (const block of content as ({ type?: unknown; text?: unknown } | null)[]) {
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
