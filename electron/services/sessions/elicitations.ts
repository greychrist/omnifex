// Sessions module — MCP elicitations
//
// An MCP server can ask the user something mid-tool-call (MCP
// `elicitation/create`). The CLI relays it to a stream-json host as a
// `control_request {subtype:'elicitation'}` and parks the session until the
// host answers — `hostAnswersElicitations` defaults to true, so this is not
// opt-in. Form mode carries a flat JSON schema for the answer; URL mode
// (MCP 2026-07-28, CLI >= 2.1.281) carries a page to open, typically a
// sign-in, and the server confirms completion on its own.
//
// One dialog per tab at a time, like permission prompts. The rest queue.
// The CLI may withdraw a request (`control_cancel_request`) when the turn is
// interrupted or the server stops waiting; a withdrawn request leaves the
// queue unanswered.

import path from 'node:path';
import { truncate } from './permissions';
import type { SessionHandle, SendToRenderer, NotificationHooks } from './types';
import type { AgentElicitationRequest, ElicitationAction } from '../agents/types';

/**
 * Narrow an action off the wire. Anything unrecognised is a cancel — the
 * answer that commits the user to nothing.
 */
export function toElicitationAction(action: string): ElicitationAction {
  return action === 'accept' || action === 'decline' ? action : 'cancel';
}

/** Push the head of the queue to the dialog, or `null` to close it. */
function showHead(handle: SessionHandle, tabId: string, sendToRenderer: SendToRenderer): void {
  sendToRenderer(`elicitation-request:${tabId}`, handle.elicitationQueue[0] ?? null);
}

export function createElicitationHandlers(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks,
): { onRequest: (req: AgentElicitationRequest) => void; onCancel: (requestId: string) => void } {
  function onRequest(req: AgentElicitationRequest): void {
    handle.elicitationQueue.push(req);
    if (handle.elicitationQueue.length !== 1) return;
    showHead(handle, tabId, sendToRenderer);

    const projectName = path.basename(handle.projectPath) || 'OmniFex';
    try {
      notificationHooks.showNotification?.(
        `OmniFex — ${projectName}`,
        truncate(req.message),
        false,
        { tabId },
        { subtitle: `${req.displayName ?? req.serverName} needs your input` },
      );
      notificationHooks.incrementUnread?.();
    } catch (e) {
      console.error('[sessions] elicitation notification hook failed:', e);
    }
  }

  function onCancel(requestId: string): void {
    const i = handle.elicitationQueue.findIndex((r) => r.requestId === requestId);
    if (i === -1) return;
    handle.elicitationQueue.splice(i, 1);
    if (i === 0) showHead(handle, tabId, sendToRenderer);
  }

  return { onRequest, onCancel };
}

/**
 * Answer the request on screen. `requestId` names the request the dialog was
 * showing; an answer for anything but the current head is stale — the CLI
 * withdrew it while the dialog was open — and is dropped rather than applied
 * to the request queued behind it.
 */
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
