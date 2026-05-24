// Sessions module — TUI-mode JSONL listener
//
// Owns the JSONL tail for a TUI-mode session. The SDK iterator is not
// running in this mode, so JSONL is the only event source. The listener:
//   1. Splits each parsed line on the same two channels the SDK path uses:
//      `claude-output-extra:<tabId>` for closure carriers (queue-operation,
//      attachment with task-notification XML), and `claude-output:<tabId>`
//      for everything else. This lets the renderer consume the TUI stream
//      through its existing handleStreamMessage pipeline — same normalization,
//      same MessageList rendering, no parallel render path.
//   2. Classifies events; on `result`, fires the shared notification helper
//      so OS notifications / dock-badge updates work identically to SDK mode.
//   3. Reports `system:init` via the `onInit` callback (cold-start sessionId
//      capture).
//   4. Updates handle status via `onStatusChange` so the renderer's loading
//      spinner and the installer's wait-for-idle gate both react.

import { createJsonlTail, isClosureCarrier, type JsonlTailHandle } from './jsonl-tail';
import { classifyRuntimeEvent } from './events';
import { dispatchResultNotification } from './notifications';
import type { NotificationHooks, SendToRenderer } from './types';

export interface CreateTuiJsonlListenerArgs {
  tabId: string;
  projectPath: string;
  jsonlPath: string;
  sendToRenderer: SendToRenderer;
  notificationHooks: NotificationHooks;
  /** Called once with the sessionId from the first `system:init` line. */
  onInit: (sessionId: string) => void;
  /** Called whenever the listener classifies a status-altering event.
   *  Lifecycle uses this to update handle.status. */
  onStatusChange?: (status: 'idle' | 'running') => void;
}

export interface TuiJsonlHandle {
  stop: () => void;
}

export function createTuiJsonlListener(args: CreateTuiJsonlListenerArgs): TuiJsonlHandle {
  const { tabId, projectPath, jsonlPath, sendToRenderer, notificationHooks, onInit, onStatusChange } = args;
  let initFired = false;
  let turnInFlight = false;

  const tail: JsonlTailHandle = createJsonlTail({
    jsonlPath,
    filter: 'all',
    onMessage: (msg) => {
      // Route to the same channels the SDK path uses so the renderer's
      // existing handleStreamMessage / extra-carrier subscriptions cover us.
      if (isClosureCarrier(msg)) {
        sendToRenderer(`claude-output-extra:${tabId}`, msg);
        return;
      }
      sendToRenderer(`claude-output:${tabId}`, msg);

      const event = classifyRuntimeEvent(msg);
      switch (event.kind) {
        case 'init':
          if (event.sessionId && !initFired) {
            initFired = true;
            onInit(event.sessionId);
          }
          // Only flip to idle from init if no turn is currently in flight —
          // protects against a CLI re-emitting system:init while a turn is
          // actively writing assistant/tool_use lines.
          if (!turnInFlight) onStatusChange?.('idle');
          break;
        case 'result':
          dispatchResultNotification({
            tabId,
            projectPath,
            event,
            sendToRenderer,
            notificationHooks,
          });
          turnInFlight = false;
          onStatusChange?.('idle');
          break;
        case 'turn':
          turnInFlight = true;
          onStatusChange?.('running');
          break;
        // streamEvent / rateLimit / compact — no status change
      }
    },
    onError: (err) => {
      console.warn(`[sessions] tui-jsonl tail error (${tabId}):`, err);
    },
  });

  return {
    stop: () => tail.stop(),
  };
}
