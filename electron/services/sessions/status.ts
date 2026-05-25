// Sessions module — status emitter
//
// Single source of truth for "session lifecycle status changes". The main
// process owns both status axes; the renderer reflects them. Whenever a
// handle transitions, call `setStatus(...)` here instead of writing the
// fields directly. Every call may emit a `session-status:<tabId>` event
// the renderer subscribes to.
//
// See `docs/session-lifecycle.md` for the full model. The two axes:
//   - sessionStatus     (the connection): 'starting' | 'started' | 'error' | 'stopped'
//   - conversationStatus (the turn):     'idle' | 'running' | 'waiting_permission'
//                                         must be null whenever sessionStatus !== 'started'
//
// Skips the event when neither field actually changed — avoids noisy
// re-emissions when the SDK iterator drives the same status repeatedly
// (e.g. successive turn events that all map to `running`).

import type {
  SessionHandle,
  SessionStatus,
  ConversationStatus,
  SendToRenderer,
} from './types';

export interface SessionStatusEvent {
  sessionStatus: SessionStatus;
  conversationStatus: ConversationStatus | null;
}

/**
 * Apply a partial transition to a handle.
 *
 * - Omit a field to leave it unchanged.
 * - Pass `conversationStatus: null` to clear it explicitly.
 * - Setting sessionStatus to anything other than 'started' automatically
 *   forces conversationStatus to `null` (the invariant from
 *   docs/session-lifecycle.md).
 * - Setting conversationStatus to a non-null value while sessionStatus is
 *   not 'started' throws — that's a programming error, not a runtime
 *   case to recover from.
 */
export function setStatus(
  handle: SessionHandle,
  patch: {
    sessionStatus?: SessionStatus;
    conversationStatus?: ConversationStatus | null;
  },
  tabId: string,
  sendToRenderer: SendToRenderer,
): void {
  const nextSession = patch.sessionStatus ?? handle.sessionStatus;
  let nextConversation: ConversationStatus | null;
  if (nextSession !== 'started') {
    // Connection is not up — there is no conversation. Force clear.
    nextConversation = null;
  } else if (patch.conversationStatus !== undefined) {
    nextConversation = patch.conversationStatus;
  } else {
    nextConversation = handle.conversationStatus;
  }

  if (
    nextConversation !== null &&
    nextSession !== 'started'
  ) {
    // Defensive — the branch above should already prevent this.
    throw new Error(
      `setStatus invariant: cannot set conversationStatus=${nextConversation} when sessionStatus=${nextSession}`,
    );
  }

  if (
    handle.sessionStatus === nextSession &&
    handle.conversationStatus === nextConversation
  ) {
    return;
  }

  handle.sessionStatus = nextSession;
  handle.conversationStatus = nextConversation;
  const payload: SessionStatusEvent = {
    sessionStatus: nextSession,
    conversationStatus: nextConversation,
  };
  sendToRenderer(`session-status:${tabId}`, payload);
}
