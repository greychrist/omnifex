// Sessions module — notification dispatch
//
// Dispatches an OS notification, dock-badge update, and renderer-side
// `claude-notification` IPC for a completed turn, and for a background
// agent that finishes after its turn already ended. Behavior wrapped in a
// pure function so any future event-stream consumer can reuse it without
// duplicating the title/body/IPC shape.

import path from 'node:path';
import type { NotificationHooks, SendToRenderer } from './types';
import type { RuntimeEvent } from './events';

export interface DispatchArgs {
  tabId: string;
  projectPath: string;
  event: Extract<RuntimeEvent, { kind: 'result' }>;
  sendToRenderer: SendToRenderer;
  notificationHooks: NotificationHooks;
}

export function dispatchResultNotification(args: DispatchArgs): void {
  const { tabId, projectPath, event, sendToRenderer, notificationHooks } = args;
  const projectName = path.basename(projectPath) || 'OmniFex';
  const title = `OmniFex — ${projectName}`;

  sendToRenderer('claude-notification', {
    tab_id: tabId,
    title,
    body: event.body,
    is_error: event.isError,
  });

  try {
    notificationHooks.showNotification?.(title, event.body, event.isError, { tabId });
    notificationHooks.incrementUnread?.();
  } catch (e) {
    console.error('[sessions] notification hook failed:', e);
  }
}

export interface DispatchAgentArgs {
  tabId: string;
  projectPath: string;
  /** The agent's own label, from the `task_started` this notification pairs with. */
  description: string;
  event: Extract<RuntimeEvent, { kind: 'taskNotification' }>;
  sendToRenderer: SendToRenderer;
  notificationHooks: NotificationHooks;
}

/** `44630` → `44s`, `724000` → `12m 04s`. Empty for a missing duration. */
function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

/**
 * Notify that a backgrounded agent finished.
 *
 * Since CLI >=2.1.232 an agent spawn is backgrounded by default: the turn
 * that launched it ends within seconds and fires its own "Task complete"
 * notification, then the agent works for minutes more. Without this, the
 * one notification the user gets is the one that arrives while the real
 * work is still running.
 *
 * The summary is deliberately not in the body — an agent's final report can
 * be pages long, and the row in the SubagentBar already carries it.
 */
export function dispatchAgentNotification(args: DispatchAgentArgs): void {
  const { tabId, projectPath, description, event, sendToRenderer, notificationHooks } = args;
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

  try {
    notificationHooks.showNotification?.(title, body, isError, { tabId });
    notificationHooks.incrementUnread?.();
  } catch (e) {
    console.error('[sessions] agent notification hook failed:', e);
  }
}
