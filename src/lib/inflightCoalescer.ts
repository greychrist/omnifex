// Per-tab text-buffer Map + RAF flush for partial assistant messages.
//
// Owns the buffer state and the RAF schedule, but does NOT own the
// rendered surface — claudeSessionStore.inflightAssistant does. React
// reconciles only on flush, never per delta.

import { useClaudeSessionStore } from '@/stores/claudeSessionStore';

interface Buffer {
  uuid: string;
  text: string;
  parentToolUseId: string | null;
}

const buffers = new Map<string, Buffer>();
let rafHandle: number | null = null;

/**
 * Append a text_delta chunk to the per-tab buffer keyed by assistant uuid.
 * A new uuid resets the buffer (any leftover partials from a never-completed
 * prior turn are discarded). Schedules a RAF flush if not already pending.
 */
export function appendInflightDelta(
  tabId: string,
  uuid: string,
  deltaText: string,
  parentToolUseId: string | null,
): void {
  const existing = buffers.get(tabId);
  if (existing && existing.uuid === uuid) {
    existing.text += deltaText;
  } else {
    buffers.set(tabId, { uuid, text: deltaText, parentToolUseId });
  }
  scheduleFlush();
}

/**
 * Drop the per-tab buffer without flushing. Call on tab close, on receipt
 * of the complete assistant message that matches, and on stream error.
 */
export function clearInflightBuffer(tabId: string): void {
  buffers.delete(tabId);
}

function scheduleFlush(): void {
  if (rafHandle !== null) return;
  rafHandle = requestAnimationFrame(flush);
}

function flush(): void {
  rafHandle = null;
  if (buffers.size === 0) return;
  const { setInflightAssistantText } = useClaudeSessionStore.getState();
  for (const [tabId, buf] of buffers) {
    setInflightAssistantText(tabId, buf.uuid, buf.text, buf.parentToolUseId);
  }
}

/** Test-only — wipe internal state between cases. */
export function __resetCoalescerForTests(): void {
  buffers.clear();
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}
