import type { ClaudeStreamMessage } from '@/types/claudeStream';
import type { MessageRenderingConfig } from './messageRenderingConfig';

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
  _allMessages: ClaudeStreamMessage[],
): string | null {
  if (msg.type === 'permission_request') return 'permission.request';

  if (msg.type === 'result') {
    const sub = (msg as any).subtype;
    return sub && /error/i.test(String(sub)) ? 'result.error' : 'result.success';
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
