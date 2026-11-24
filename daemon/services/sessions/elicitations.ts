// The CLI parks the session until the host answers (`hostAnswersElicitations` defaults to true).

import path from 'node:path';
import { truncate } from './permissions';
import type { SessionHandle, SendToRenderer } from './types';
import type { AgentElicitationRequest, ElicitationAction } from '../agents/types';

export function toElicitationAction(action: string): ElicitationAction {
  return action === 'accept' || action === 'decline' ? action : 'cancel';
}

function showHead(handle: SessionHandle, tabId: string, sendToRenderer: SendToRenderer): void {
  sendToRenderer(`elicitation-request:${tabId}`, handle.elicitationQueue[0] ?? null);
}

export function createElicitationHandlers(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
): { onRequest: (req: AgentElicitationRequest) => void; onCancel: (requestId: string) => void } {
  function onRequest(req: AgentElicitationRequest): void {
    handle.elicitationQueue.push(req);
    if (handle.elicitationQueue.length !== 1) return;
    showHead(handle, tabId, sendToRenderer);

    const projectName = path.basename(handle.projectPath) || 'OmniFex';
    sendToRenderer('claude-notification', {
      tab_id: tabId,
      title: `OmniFex — ${projectName}`,
      body: truncate(req.message),
      is_error: false,
      subtitle: `${req.displayName ?? req.serverName} needs your input`,
    });
  }

  function onCancel(requestId: string): void {
    const i = handle.elicitationQueue.findIndex((r) => r.requestId === requestId);
    if (i === -1) return;
    handle.elicitationQueue.splice(i, 1);
    if (i === 0) showHead(handle, tabId, sendToRenderer);
  }

  return { onRequest, onCancel };
}

// An answer for anything but the head is stale (the CLI withdrew it) and is dropped, never applied to the next request.
export async function respondToElicitation(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
  action: ElicitationAction,
  content: Record<string, unknown> | undefined,
  requestId: string | undefined,
): Promise<void> {
  const head = handle.elicitationQueue[0];
  if (!head) return;
  if (requestId !== undefined && head.requestId !== requestId) return;
  handle.elicitationQueue.shift();
  showHead(handle, tabId, sendToRenderer);
  await handle.engine.respondElicitation?.(head.requestId, action, content);
}
