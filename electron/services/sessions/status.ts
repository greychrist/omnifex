// Sessions module — status emitter (sessionStatus only).
//
// The renderer derives conversationStatus from JSONL content + task/subagent
// stores (see src/lib/sessionDerivedState.ts and the
// docs/superpowers/specs/2026-05-27-jsonl-as-rendered-design.md spec).
// Main process owns sessionStatus only — the "is the CLI process up?" axis.
//
// See `docs/session-lifecycle.md` for the model.

import type { SessionHandle, SessionStatus, SendToRenderer } from './types';

export interface SessionStatusEvent {
  sessionStatus: SessionStatus;
}

/**
 * Apply a partial transition to a handle. Omits the conversationStatus axis
 * entirely — that's the renderer's job now.
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
}
