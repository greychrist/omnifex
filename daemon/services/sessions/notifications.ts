import path from 'node:path';
import type { SendToRenderer } from './types';
import type { RuntimeEvent } from './events';
import type { ModNotice } from './mod-notifications';

export interface DispatchArgs {
  tabId: string;
  projectPath: string;
  event: Extract<RuntimeEvent, { kind: 'result' }>;
  sendToRenderer: SendToRenderer;
}

export function dispatchResultNotification(args: DispatchArgs): void {
  const { tabId, projectPath, event, sendToRenderer } = args;
  const projectName = path.basename(projectPath) || 'OmniFex';
  const title = `OmniFex — ${projectName}`;

  sendToRenderer('claude-notification', {
    tab_id: tabId,
    title,
    body: event.body,
    is_error: event.isError,
  });
}

export interface DispatchAgentArgs {
  tabId: string;
  projectPath: string;
  description: string;
  event: Extract<RuntimeEvent, { kind: 'taskNotification' }>;
  sendToRenderer: SendToRenderer;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export function dispatchAgentNotification(args: DispatchAgentArgs): void {
  const { tabId, projectPath, description, event, sendToRenderer } = args;
  const projectName = path.basename(projectPath) || 'OmniFex';
  const title = `OmniFex — ${projectName}`;
  const isError = event.status !== 'completed';

  const label = isError ? 'Agent failed' : 'Agent finished';
  const elapsed = isError ? '' : formatDuration(event.durationMs);
  const body = [
    description ? `${label}: ${description}` : label,
    elapsed,
  ].filter(Boolean).join(' · ');

  sendToRenderer('claude-notification', {
    tab_id: tabId,
    title,
    body,
    is_error: isError,
  });
}

// `origin: 'mod'` keeps it from marking the tab as having an unread result.
export function dispatchModNotification(tabId: string, notice: ModNotice, sendToRenderer: SendToRenderer): void {
  sendToRenderer('claude-notification', {
    tab_id: tabId,
    title: notice.title,
    subtitle: notice.subtitle,
    body: notice.body,
    is_error: false,
    id: notice.id,
    origin: 'mod',
    ...(notice.deliverAt !== null ? { deliver_at: notice.deliverAt } : {}),
  });
}

export function dispatchModNotificationRemoval(ids: string[], sendToRenderer: SendToRenderer): void {
  if (ids.length > 0) sendToRenderer('claude-notification-remove', { ids });
}
