// Sessions module — TUI-mode JSONL listener
//
// Owns the JSONL tail for a TUI-mode session. The SDK iterator is not
// running in this mode, so JSONL is the only event source. The listener:
//   1. Forwards every parsed line on `session-jsonl:<tabId>` so the renderer
//      can populate the MessagePanel.
//   2. Classifies events; on `result`, fires the shared notification helper
//      so OS notifications / dock-badge updates work identically to SDK
//      mode.
//   3. Reports `system:init` via the `onInit` callback so the lifecycle
//      layer can capture sessionId for sessions started cold.

import { createJsonlTail, type JsonlTailHandle } from './jsonl-tail';
import { classifyRuntimeEvent } from './events';
import { dispatchResultNotification } from './notifications';
import type { NotificationHooks, SendToRenderer } from './types';

export interface CreateTuiJsonlListenerArgs {
  tabId: string;
  projectPath: string;
  jsonlPath: string;
  sendToRenderer: SendToRenderer;
  notificationHooks: NotificationHooks;
  /** Called with the sessionId from the first `system:init` line. */
  onInit: (sessionId: string) => void;
}

export interface TuiJsonlHandle {
  stop: () => void;
}

export function createTuiJsonlListener(args: CreateTuiJsonlListenerArgs): TuiJsonlHandle {
  const { tabId, projectPath, jsonlPath, sendToRenderer, notificationHooks, onInit } = args;

  let initFired = false;

  const tail: JsonlTailHandle = createJsonlTail({
    jsonlPath,
    filter: 'all',
    onMessage: (msg) => {
      sendToRenderer(`session-jsonl:${tabId}`, msg);

      const event = classifyRuntimeEvent(msg);
      if (event.kind === 'init' && event.sessionId && !initFired) {
        initFired = true;
        onInit(event.sessionId);
      } else if (event.kind === 'result') {
        dispatchResultNotification({
          tabId,
          projectPath,
          event,
          sendToRenderer,
          notificationHooks,
        });
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
