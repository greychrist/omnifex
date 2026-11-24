import { formatDurationMs } from './duration';
import { formatTokens } from './contextPressure';
import type { CliResultRaw, JsonlNode, RateLimitEventInfo, SystemRaw } from '@/types/jsonl';

/** SendFeedback sends only display fields over the wire; the draft stays on disk, so there is no body field. */
function feedbackDraftBody(raw: SystemRaw): string {
  const head = [raw.draft_type, raw.title].filter(Boolean).join(' · ');
  const preview = raw.details_preview?.trim();
  return preview ? `${head}\n${preview}` : head;
}

/** `text` is plain text by contract: never draw it as markup. */
function modLineBody(raw: SystemRaw): string {
  const { plugin, text } = raw as unknown as { plugin?: unknown; text?: unknown };
  const body = typeof text === 'string' ? text : '';
  return typeof plugin === 'string' && plugin ? `${plugin} · ${body}` : body;
}

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

function cliResultBody(raw: CliResultRaw): string {
  const parts: string[] = [];
  if (raw.subtype) parts.push(raw.subtype);
  if (typeof raw.duration_ms === 'number') parts.push(formatDurationMs(raw.duration_ms));
  if (typeof raw.num_turns === 'number') parts.push(`${raw.num_turns} turn${raw.num_turns === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

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

export function systemRecordText(raw: SystemRaw, subtype: string): string {
  if (subtype === 'thinking_tokens') {
    const n = (raw as unknown as { estimated_tokens?: number }).estimated_tokens;
    return typeof n === 'number' ? `Thought ~${n.toLocaleString()} tokens` : '';
  }
  if (subtype === 'feedback_draft_queued') return feedbackDraftBody(raw);
  if (subtype === 'stop_hook_summary') return stopHookSummaryBody(raw);
  if (subtype === 'compact_boundary') return compactBoundaryBody(raw);
  if (subtype === 'ui_log' || subtype === 'ui_toast') return modLineBody(raw);
  if (subtype === 'status') return statusText(raw);
  const r = raw as unknown as { message?: unknown; content?: unknown; body?: unknown; title?: unknown };
  const v = r.message ?? r.content ?? r.body ?? r.title ?? '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function statusText(raw: SystemRaw): string {
  const r = raw as unknown as {
    status?: unknown; permissionMode?: unknown; compact_result?: unknown;
    compact_error?: unknown; compact_output_chars?: unknown; resume_held_for_plan?: unknown;
  };
  if (typeof r.status === 'string' && r.status) {
    return typeof r.compact_output_chars === 'number'
      ? `${r.status} · ${r.compact_output_chars.toLocaleString()} chars`
      : r.status;
  }
  if (typeof r.compact_result === 'string') {
    return typeof r.compact_error === 'string' && r.compact_error
      ? `compaction ${r.compact_result} · ${r.compact_error}`
      : `compaction ${r.compact_result}`;
  }
  if (typeof r.permissionMode === 'string') return `permission → ${r.permissionMode}`;
  if (r.resume_held_for_plan === true) return 'interrupted plan-mode turn not re-run';
  return '';
}

type BookkeepingNode = Extract<JsonlNode, { kind: 'permission-mode' | 'last-prompt' | 'ai-title' | 'custom-title' | 'queue-operation' | 'file-history-snapshot' }>;

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
      const detail = reason
        ? reason.replace(/_/g, ' ').replace(/\bmid turn\b/, 'mid-turn')
        : wait !== null && wait >= 1000 ? `waited ${formatDurationMs(wait)}` : null;
      return `Input queue: ${operation}${detail ? ` · ${detail}` : ''}`;
    }
    case 'file-history-snapshot':
      return node.raw.messageId ? `File snapshot (${node.raw.messageId})` : 'File snapshot';
  }
}

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

export function streamEnvelopeText(node: Extract<JsonlNode, { kind: 'cli-stream-init' | 'cli-stream-result' }>): string {
  return node.kind === 'cli-stream-init'
    ? [node.raw.model, node.raw.cwd].filter(Boolean).join(' · ')
    : cliResultBody(node.raw);
}
