import type { ClaudeStreamMessage } from '@/types/claudeStream';
import type { MessageRenderingConfig } from './messageRenderingConfig';
import { deriveSubagents } from './subagentStreams';

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
  if (msg.type === 'permission_request') return 'permission.request';

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
  }

  return null;
}

/**
 * In compact mode, drop messages whose classified kind is marked
 * `hiddenInCompact` (unless the kind is boundary-locked, which mergeConfig
 * already guards against but we defend again here).
 */
export function filterCompactHidden(
  messages: ClaudeStreamMessage[],
  config: MessageRenderingConfig,
): ClaudeStreamMessage[] {
  return messages.filter((m) => {
    const id = classifyStandaloneKind(m, messages);
    if (!id) return true;
    const kind = config.kinds[id];
    if (!kind) return true;
    if (kind.compactBoundaryLocked) return true;
    return !kind.hiddenInCompact;
  });
}
