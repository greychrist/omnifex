// Sessions module — TUI-mode JSONL listener
//
// Owns the JSONL tail for a TUI-mode session. The CLI stream-json output
// is not running in this mode, so JSONL is the only event source. The listener:
//   1. Splits each parsed line on the same two channels the stream-json path uses:
//      `claude-output-extra:<tabId>` for closure carriers (queue-operation,
//      attachment with task-notification XML), and `agent-output:<tabId>`
//      for everything else. This lets the renderer consume the TUI stream
//      through its existing handleStreamMessage pipeline — same normalization,
//      same MessageList rendering, no parallel render path.
//   2. Classifies events; on `result`, fires the shared notification helper
//      so OS notifications / dock-badge updates work identically to stream-json mode.
//   3. Reports `system:init` via the `onInit` callback (cold-start sessionId
//      capture).
//   4. Updates handle status via `onStatusChange` so the renderer's loading
//      spinner and the installer's wait-for-idle gate both react.

import { createJsonlTail, isClosureCarrier, type JsonlTailHandle } from './jsonl-tail';
import { classifyRuntimeEvent } from './events';
import { dispatchResultNotification } from './notifications';
import type { NotificationHooks, SendToRenderer } from './types';

const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'refusal',
  'model_context_window_exceeded',
]);

const SUCCESS_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'stop_sequence',
]);

/**
 * Build a synthetic `result` RuntimeEvent from a JSONL assistant line that
 * carries a terminal stop_reason. The CLI's interactive TUI never writes
 * top-level `result` lines, so we manufacture one here so the shared
 * notification helper (`dispatchResultNotification`) fires identically to
 * stream-json mode.
 *
 * Returns null when the stop_reason is non-terminal (tool_use, null, etc.),
 * meaning the turn isn't done yet.
 */
function synthResultFromAssistant(raw: unknown): { isError: boolean; body: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== 'assistant') return null;
  const msg = r.message as Record<string, unknown> | undefined;
  if (!msg) return null;
  const stop = typeof msg.stop_reason === 'string' ? msg.stop_reason : null;
  if (!stop || !TERMINAL_STOP_REASONS.has(stop)) return null;
  const isError = !SUCCESS_STOP_REASONS.has(stop);
  const content = msg.content;
  const body = extractAssistantText(content) || (isError ? 'Task failed' : 'Task complete');
  return { isError, body: body.slice(0, 200) };
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: string; text?: string } =>
      !!c && typeof c === 'object' && (c as { type?: string }).type === 'text'
    )
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .join('');
}

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
  /** Called when the model, permission mode, or effort the user is running
   *  changes — detected by tailing the JSONL the CLI writes in TUI mode. In
   *  TUI mode the PTY is the source of truth (the popover can't drive the CLI
   *  via the control protocol), so this is how OmniFex's read-only mirror
   *  stays in sync when the user switches model (`/model`), cycles permission
   *  mode (shift+tab), or changes effort inside the terminal. Fires once per
   *  actual change (deduped). Effort became detectable in CLI 2.1.212, which
   *  stamps a top-level `effort` field on assistant lines; thinking still
   *  never reaches the JSONL and stays uncovered. */
  onControlState?: (state: { model?: string; permissionMode?: string; effort?: string }) => void;
}

export interface TuiJsonlHandle {
  stop: () => void;
}

/**
 * Pull a control-state delta (model / permission mode / effort) out of a
 * parsed JSONL line, or null when the line carries none. `model` rides on
 * `assistant` lines (`message.model`) and `effort` on the same lines as a
 * top-level field (CLI ≥2.1.212); `permissionMode` rides on dedicated
 * `permission-mode` records and on `user` envelopes (both carry the field).
 */
function controlStateFromLine(
  raw: unknown,
): { model?: string; permissionMode?: string; effort?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.type === 'assistant') {
    const delta: { model?: string; effort?: string } = {};
    const model = (r.message as { model?: unknown } | undefined)?.model;
    if (typeof model === 'string' && model.length > 0) delta.model = model;
    if (typeof r.effort === 'string' && r.effort.length > 0) delta.effort = r.effort;
    return delta.model || delta.effort ? delta : null;
  }
  if (r.type === 'permission-mode' || r.type === 'user') {
    const mode = r.permissionMode;
    if (typeof mode === 'string' && mode.length > 0) return { permissionMode: mode };
  }
  return null;
}

export function createTuiJsonlListener(args: CreateTuiJsonlListenerArgs): TuiJsonlHandle {
  const { tabId, projectPath, jsonlPath, sendToRenderer, notificationHooks, onInit, onStatusChange, onControlState } = args;
  let initFired = false;
  let turnInFlight = false;
  let lastModel: string | null = null;
  let lastPermissionMode: string | null = null;
  let lastEffort: string | null = null;

  const tail: JsonlTailHandle = createJsonlTail({
    jsonlPath,
    filter: 'all',
    onMessage: (msg) => {
      // Route to the same channels the stream-json path uses so the renderer's
      // existing handleStreamMessage / extra-carrier subscriptions cover us.
      if (isClosureCarrier(msg)) {
        sendToRenderer(`claude-output-extra:${tabId}`, msg);
        return;
      }
      sendToRenderer(`agent-output:${tabId}`, msg);

      // Mirror model / permission-mode changes the user made inside the
      // terminal back to OmniFex's read-only pickers. Deduped so each actual
      // switch fires once (assistant lines repeat the same model every turn).
      if (onControlState) {
        const delta = controlStateFromLine(msg);
        if (delta?.model && delta.model !== lastModel) {
          lastModel = delta.model;
          onControlState({ model: delta.model });
        }
        if (delta?.permissionMode && delta.permissionMode !== lastPermissionMode) {
          lastPermissionMode = delta.permissionMode;
          onControlState({ permissionMode: delta.permissionMode });
        }
        if (delta?.effort && delta.effort !== lastEffort) {
          lastEffort = delta.effort;
          onControlState({ effort: delta.effort });
        }
      }

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

      // JSONL has no top-level `result` lines (only the CLI stream-json output
      // produces those). Synthesize one from any `assistant` line with a terminal
      // stop_reason so the OS notification fires.
      const synth = synthResultFromAssistant(msg);
      if (synth) {
        dispatchResultNotification({
          tabId,
          projectPath,
          event: { kind: 'result', isError: synth.isError, body: synth.body },
          sendToRenderer,
          notificationHooks,
        });
        onStatusChange?.('idle');
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
