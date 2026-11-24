// The renderer mirrors both axes; neither is derived from the transcript.

import { IDLE_TURN, type SessionHandle, type SessionStatus, type SendToRenderer, type TurnState } from './types';

export interface SessionStatusEvent {
  sessionStatus: SessionStatus;
}

// A session that stops or errors cannot still be working, so those transitions close the turn too.
export function setStatus(
  handle: SessionHandle,
  patch: { sessionStatus?: SessionStatus },
  tabId: string,
  sendToRenderer: SendToRenderer,
): void {
  const next = patch.sessionStatus ?? handle.sessionStatus;
  if (handle.sessionStatus === next) return;
  handle.sessionStatus = next;
  sendToRenderer(`session-status:${tabId}`, { sessionStatus: next } satisfies SessionStatusEvent);
  if (next === 'stopped' || next === 'error') setTurn(handle, 'idle', tabId, sendToRenderer);
}

// Idempotent: re-opening a running turn keeps its original `since`.
export function setTurn(
  handle: SessionHandle,
  status: TurnState['status'],
  tabId: string,
  sendToRenderer: SendToRenderer,
  now: () => string = () => new Date().toISOString(),
): void {
  if (handle.turn.status === status) return;
  handle.turn = status === 'running' ? { status, since: now() } : IDLE_TURN;
  sendToRenderer(`session-turn:${tabId}`, { ...handle.turn } satisfies TurnState);
  handle.turnObserver?.(status);
}
