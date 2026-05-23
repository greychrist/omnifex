// Sessions module — notification dispatch
//
// Dispatches an OS notification, dock-badge update, and renderer-side
// `claude-notification` IPC for a completed turn. Behavior wrapped in a
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
