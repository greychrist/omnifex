/**
 * The text a non-message record shows: the body of its Compact card, and the
 * line Modern draws for it (modernLines.ts). One copy, so the two formats
 * cannot word the same record differently. Pure.
 */
import { formatDurationMs } from './duration';
import { formatTokens } from './contextPressure';
import type { CliResultRaw, JsonlNode, RateLimitEventInfo, SystemRaw } from '@/types/jsonl';

/**
 * Body line for a `system:feedback_draft_queued` card.
 *
 * The CLI's SendFeedback tool writes the draft to
 * `<CLAUDE_CONFIG_DIR>/feedback/drafts/` and sends only display fields over the
 * wire — there is no `content`/`body`/`message` field for the generic system
 * branch to pick up, and the model is told not to mention the draft in the
 * transcript. Without this the card would be the title alone, or nothing.
 */
function feedbackDraftBody(raw: SystemRaw): string {
  const head = [raw.draft_type, raw.title].filter(Boolean).join(' · ');
  const preview = raw.details_preview?.trim();
  return preview ? `${head}\n${preview}` : head;
}

/**
 * Body line for a mod's `system:ui_log` / `system:ui_toast`: the plugin's name
 * and its text, the way the REPL shows them under the plugin's name. `text`
 * is plain text by contract ("draw it as a text node, never as markup").
 */
function modLineBody(raw: SystemRaw): string {
  const { plugin, text } = raw as unknown as { plugin?: unknown; text?: unknown };
  const body = typeof text === 'string' ? text : '';
  return typeof plugin === 'string' && plugin ? `${plugin} · ${body}` : body;
}

/**
 * Body line for a `system:compact_boundary` marker: the CLI's own line, then
 * the trigger, the token drop and the time, from whichever metadata is there.
 */
function compactBoundaryBody(raw: SystemRaw): string {
  const meta = raw.compactMetadata ?? {};
  const parts = [raw.content || 'Conversation compacted'];
  if (meta.trigger) parts.push(meta.trigger);
  if (typeof meta.preTokens === 'number' && typeof meta.postTokens === 'number') {
    parts.push(`${formatTokens(meta.preTokens)} → ${formatTokens(meta.postTokens)} tokens`);
  }
  if (typeof meta.durationMs === 'number') parts.push(formatDurationMs(meta.durationMs));
  return parts.join(' · ');
}

/** Body line for the stream's turn-end envelope: outcome, duration, model calls. */
function cliResultBody(raw: CliResultRaw): string {
  const parts: string[] = [];
  if (raw.subtype) parts.push(raw.subtype);
  if (typeof raw.duration_ms === 'number') parts.push(formatDurationMs(raw.duration_ms));
  if (typeof raw.num_turns === 'number') parts.push(`${raw.num_turns} turn${raw.num_turns === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * Body line for a `system:stop_hook_summary` card: each Stop hook by file name
 * and duration, then any errors and whether one blocked the turn from ending.
 * The record has no narrative field, so the generic branch would show nothing.
 */
function stopHookSummaryBody(raw: SystemRaw): string {
  const hooks = (raw.hookInfos ?? [])
    .map((h) => {
      const name = (h.command ?? '').split('/').pop() || 'hook';
      return typeof h.durationMs === 'number' ? `${name} · ${h.durationMs}ms` : name;
    })
    .join(', ');
  const errors = raw.hookErrors?.length ?? 0;
  return [
    hooks,
    errors > 0 && `${errors} ${errors === 1 ? 'error' : 'errors'}`,
    raw.preventedContinuation && (raw.stopReason ? `blocked stop: ${raw.stopReason}` : 'blocked stop'),
  ].filter(Boolean).join(' · ');
}

/**
 * The body of a `system` record the Compact fallback card draws: a per-subtype
 * synthesis where the record has no narrative field (thinking_tokens,
 * feedback_draft_queued, stop_hook_summary, compact_boundary, mod lines), else
 * whichever narrative field it carries. `content` holds the recap for
 * away_summary; `body` is the notification-style shape some warnings use.
 * thinking_tokens is past tense: messageFilters collapses each burst to its
 * final ping. feedback_draft_queued's draft stays on disk under
 * <CLAUDE_CONFIG_DIR>/feedback/drafts/; only its display fields cross the wire.
 */
export function systemRecordText(raw: SystemRaw, subtype: string): string {
  if (subtype === 'thinking_tokens') {
    const n = (raw as unknown as { estimated_tokens?: number }).estimated_tokens;
    return typeof n === 'number' ? `Thought ~${n.toLocaleString()} tokens` : '';
  }
  if (subtype === 'feedback_draft_queued') return feedbackDraftBody(raw);
  if (subtype === 'stop_hook_summary') return stopHookSummaryBody(raw);
  if (subtype === 'compact_boundary') return compactBoundaryBody(raw);
  if (subtype === 'ui_log' || subtype === 'ui_toast') return modLineBody(raw);
  const r = raw as unknown as { message?: unknown; content?: unknown; body?: unknown; title?: unknown };
  const v = r.message ?? r.content ?? r.body ?? r.title ?? '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

type BookkeepingNode = Extract<JsonlNode, { kind: 'permission-mode' | 'last-prompt' | 'ai-title' | 'custom-title' | 'queue-operation' | 'file-history-snapshot' }>;

/** The line for a bookkeeping JSONL record. `queueWaitMs` is the dequeue's
 *  wait behind a running turn, from the row's lookups. */
export function bookkeepingText(node: BookkeepingNode, queueWaitMs: number | null = null): string {
  switch (node.kind) {
    case 'permission-mode':
      return `Permission → ${node.raw.permissionMode}`;
    case 'last-prompt':
      return 'Bookmarked prompt';
    case 'ai-title':
      return `Session titled "${node.raw.aiTitle}"`;
    case 'custom-title':
      return `Renamed to "${node.raw.customTitle}"`;
    case 'queue-operation': {
      const { operation, reason } = node.raw;
      const wait = operation === 'dequeue' ? queueWaitMs : null;
      // Under a second is the CLI picking the input up at once; only a real
      // wait behind a running turn is worth a number.
      const detail = reason
        ? reason.replace(/_/g, ' ').replace(/\bmid turn\b/, 'mid-turn')
        : wait !== null && wait >= 1000 ? `waited ${formatDurationMs(wait)}` : null;
      return `Input queue: ${operation}${detail ? ` · ${detail}` : ''}`;
    }
    case 'file-history-snapshot':
      return node.raw.messageId ? `File snapshot (${node.raw.messageId})` : 'File snapshot';
  }
}

/**
 * rate_limit_event has no narrative field: rateLimitType · status [· resets
 * <time>] [· overage rejected], empty when the info block is absent.
 */
export function rateLimitText(info: RateLimitEventInfo | undefined): string {
  const segments: string[] = [];
  if (info) {
    const head = [info.rateLimitType, info.status].filter(Boolean).join(' · ');
    if (head) segments.push(head);
    if (typeof info.resetsAt === 'number') {
      const time = new Date(info.resetsAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      segments.push(`resets ${time}`);
    }
    if (info.overageStatus === 'rejected') segments.push('overage rejected');
  }
  return segments.join(' · ');
}

/**
 * A top-level `progress` record: its `data.type` variant, then its scalar
 * fields. No per-variant layout — the shape has never been seen on disk, so
 * this shows whatever arrives rather than guessing at it.
 */
export function progressText(data: Record<string, unknown> | undefined): { variant: string | null; fields: string } {
  const variant = typeof data?.type === 'string' ? data.type : null;
  const fields = data
    ? Object.entries(data)
      .filter(([k, v]) => k !== 'type' && v !== null && ['string', 'number', 'boolean'].includes(typeof v))
      .map(([k, v]) => {
        const s = String(v);
        return `${k}=${s.length > 80 ? `${s.slice(0, 79)}…` : s}`;
      })
      .join(' · ')
    : '';
  return { variant, fields };
}

/** The stream's session-start (model · cwd) and turn-end envelopes. */
export function streamEnvelopeText(node: Extract<JsonlNode, { kind: 'cli-stream-init' | 'cli-stream-result' }>): string {
  return node.kind === 'cli-stream-init'
    ? [node.raw.model, node.raw.cwd].filter(Boolean).join(' · ')
    : cliResultBody(node.raw);
}
