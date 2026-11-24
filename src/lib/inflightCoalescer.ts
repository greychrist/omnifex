import { useClaudeSessionStore } from '@/stores/claudeSessionStore';

/** Each flush re-parses the whole turn's Markdown; per-frame flushing was the dominant streaming CPU cost. */
export const FLUSH_INTERVAL_MS = 100;

interface Buffer {
  /** The CLI mints a fresh uuid per stream_event: not a turn key, never reset the buffer on it. */
  uuid: string;
  text: string;
  parentToolUseId: string | null;
}

const buffers = new Map<string, Buffer>();
const thinkingBuffers = new Map<string, string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// -Infinity so the first delta after an idle gap flushes on the next tick.
let lastFlushAt = Number.NEGATIVE_INFINITY;

export function appendInflightDelta(
  tabId: string,
  uuid: string,
  deltaText: string,
  parentToolUseId: string | null,
): void {
  const existing = buffers.get(tabId);
  if (existing) {
    existing.text += deltaText;
    existing.uuid = uuid;
  } else {
    buffers.set(tabId, { uuid, text: deltaText, parentToolUseId });
  }
  scheduleFlush();
}

/** The only thing that ends a streaming turn for the coalescer. */
export function clearInflightBuffer(tabId: string): void {
  buffers.delete(tabId);
}

export function appendInflightThinkingDelta(tabId: string, deltaText: string): void {
  thinkingBuffers.set(tabId, (thinkingBuffers.get(tabId) ?? '') + deltaText);
  scheduleFlush();
}

export function clearInflightThinking(tabId: string): void {
  thinkingBuffers.delete(tabId);
  useClaudeSessionStore.getState().clearInflightThinking(tabId);
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  const delay = Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - lastFlushAt));
  flushTimer = setTimeout(flush, delay);
}

function flush(): void {
  flushTimer = null;
  if (buffers.size === 0 && thinkingBuffers.size === 0) return;
  lastFlushAt = Date.now();
  const { setInflightAssistantText, setInflightThinkingText } = useClaudeSessionStore.getState();
  for (const [tabId, buf] of buffers) {
    setInflightAssistantText(tabId, buf.uuid, buf.text, buf.parentToolUseId);
  }
  for (const [tabId, text] of thinkingBuffers) {
    setInflightThinkingText(tabId, text);
  }
}

export function __resetCoalescerForTests(): void {
  buffers.clear();
  thinkingBuffers.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  lastFlushAt = Number.NEGATIVE_INFINITY;
}
