// Per-tab text-buffer Map + throttled flush for partial assistant messages.
//
// Owns the buffer state and the flush schedule, but does NOT own the
// rendered surface — claudeSessionStore.inflightAssistant does. React
// reconciles only on flush, never per delta.

import { useClaudeSessionStore } from '@/stores/claudeSessionStore';

/**
 * Minimum wall-clock gap between store writes for in-flight text.
 *
 * Every flush re-renders InflightAssistantBubble, which re-parses the *entire*
 * accumulated turn through ReactMarkdown (plus Prism for any code). That cost
 * grows with the length of the answer, so flushing per animation frame made a
 * long response re-parse itself ~60x/second — the dominant renderer CPU cost
 * while streaming, and far more often than anyone can read. Throttling to
 * 100ms cuts those re-parses ~6x while still reading as live text.
 */
export const FLUSH_INTERVAL_MS = 100;

interface Buffer {
  /** uuid of the most-recent stream_event message — informational only.
   *  The CLI emits a fresh uuid per stream_event (each delta gets its own),
   *  so this is NOT a stable assistant-turn key and must not be used to
   *  decide whether to reset the buffer. */
  uuid: string;
  text: string;
  parentToolUseId: string | null;
}

const buffers = new Map<string, Buffer>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// -Infinity, not 0, so the first delta after an idle gap flushes on the next
// tick instead of waiting out a full interval — the throttle must never delay
// the first visible token of a turn.
let lastFlushAt = Number.NEGATIVE_INFINITY;

/**
 * Append a text_delta chunk to the per-tab buffer. Always accumulates within
 * the tab's current streaming turn. The buffer is cleared explicitly via
 * clearInflightBuffer() on assistant-complete / error / unmount — that's the
 * only thing that ends a turn from the coalescer's perspective.
 *
 * (Earlier versions keyed by `uuid` and reset on uuid mismatch, but the CLI
 * assigns a fresh uuid to every stream_event — see assistant.mjs's
 * stream_event constructor — so that key was effectively "always reset",
 * which left the bubble showing only the most recent delta.)
 */
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
    // parentToolUseId stable within a turn; first value wins.
  } else {
    buffers.set(tabId, { uuid, text: deltaText, parentToolUseId });
  }
  scheduleFlush();
}

/**
 * Drop the per-tab buffer without flushing. Call on tab close, on receipt
 * of the complete assistant message, and on stream error. This is the only
 * thing that ends a streaming turn for the coalescer.
 */
export function clearInflightBuffer(tabId: string): void {
  buffers.delete(tabId);
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  const delay = Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - lastFlushAt));
  flushTimer = setTimeout(flush, delay);
}

function flush(): void {
  flushTimer = null;
  // Nothing buffered means the turn was cleared before this fired. Leave
  // lastFlushAt alone: no store write happened, so the next real delta has
  // no reason to serve out a throttle window.
  if (buffers.size === 0) return;
  lastFlushAt = Date.now();
  const { setInflightAssistantText } = useClaudeSessionStore.getState();
  for (const [tabId, buf] of buffers) {
    setInflightAssistantText(tabId, buf.uuid, buf.text, buf.parentToolUseId);
  }
}

/** Test-only — wipe internal state between cases. */
export function __resetCoalescerForTests(): void {
  buffers.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  lastFlushAt = Number.NEGATIVE_INFINITY;
}
