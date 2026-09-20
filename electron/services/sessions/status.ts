// Sessions module — status emitter (sessionStatus + the turn axis).
//
// Main process owns both axes the session can answer for itself: is the CLI
// process up (`sessionStatus`), and is it working on a prompt (`turn`). The
// renderer mirrors them; it does not derive either from the transcript.
//
// See `docs/session-lifecycle.md` for the model.

import { IDLE_TURN, type SessionHandle, type SessionStatus, type SendToRenderer, type TurnState } from './types';

export interface SessionStatusEvent {
  sessionStatus: SessionStatus;
}

/**
 * Apply a partial transition to a handle and announce it on
 * `session-status:<tabId>`. A session that stops or errors cannot still be
 * working, so those transitions close the turn too.
 */
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

/**
 * Flip the turn axis and announce it on `session-turn:<tabId>`. Idempotent:
 * re-opening a running turn keeps its original `since`.
 */
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
}
