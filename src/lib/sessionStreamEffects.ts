import type { StreamReducerEffect } from './sessionStreamReducer';

/**
 * Side-effect runner for the pure stream reducer.
 *
 * `reduceSessionStreamMessage` returns an array of `StreamReducerEffect`
 * descriptors — fire-and-forget async work the renderer needs to do once
 * per stream message (refresh context usage, fetch account info, drain the
 * queued-prompt buffer, etc.). The reducer stays pure so it can be tested
 * without React; this module collects the effects' actual implementations
 * in one testable place rather than inlining a switch statement inside
 * `ClaudeCodeSession.handleStreamMessage`.
 *
 * Errors are swallowed and forwarded to `deps.onError` so a single failed
 * fetch never breaks the stream loop.
 */

export interface StreamEffectApi {
  // `unknown` already includes null/undefined; the `| null` was redundant.
  sessionAccountInfo(tabId: string): Promise<unknown>;
  sessionContextUsage(tabId: string): Promise<unknown>;
  sessionSupportedModels(tabId: string): Promise<unknown[] | null>;
  sessionSupportedCommands(tabId: string): Promise<unknown[] | null>;
}

export interface QueuedPrompt {
  prompt: string;
  model: string;
  // Optional pasted images, forwarded to handleSendPrompt on drain so a
  // queued prompt with images sends as the same structured-content blocks
  // an inline submission would have produced.
  images?: string[];
}

export interface StreamEffectDeps<Q extends QueuedPrompt = QueuedPrompt> {
  tabId: string;
  projectPath: string;
  api: StreamEffectApi;
  persistSession: (params: {
    sessionId: string;
    projectId: string;
    projectPath: string;
    messageCount: number;
  }) => void;
  setSdkAccountInfo: (info: unknown) => void;
  setContextUsage: (usage: unknown) => void;
  setSupportedModels: (models: unknown[]) => void;
  setSupportedCommands: (commands: unknown[]) => void;
  queuedPromptsRef: { current: Q[] };
  setQueuedPrompts: (next: Q[]) => void;
  handleSendPrompt: (prompt: string, model: string, images?: string[]) => void;
  /** Resolved directive text (user override or shipped default) — see
   *  `resolvePostCompactPrompt`. Resolved by the caller so this module stays
   *  synchronous and free of IPC. */
  postCompactPrompt: string;
  /** Model the session is currently on, stamped onto the queued directive so
   *  it sends on the same model as the work it is correcting. */
  currentModel: string;
  onError: (kind: StreamReducerEffect['kind'], err: unknown) => void;
}

export function runStreamEffect<Q extends QueuedPrompt = QueuedPrompt>(
  effect: StreamReducerEffect,
  deps: StreamEffectDeps<Q>,
): void {
  switch (effect.kind) {
    case 'saveSessionPersistence':
      deps.persistSession({
        sessionId: effect.sessionId,
        projectId: effect.projectId,
        projectPath: deps.projectPath,
        messageCount: effect.messageCount,
      });
      return;

    case 'fetchAccountInfo':
      deps.api
        .sessionAccountInfo(deps.tabId)
        .then((info) => {
          if (info) deps.setSdkAccountInfo(info);
        })
        .catch((err: unknown) => { deps.onError('fetchAccountInfo', err); });
      return;

    case 'refreshContextUsage':
      deps.api
        .sessionContextUsage(deps.tabId)
        .then((usage) => {
          if (usage) deps.setContextUsage(usage);
        })
        .catch((err: unknown) => { deps.onError('refreshContextUsage', err); });
      return;

    case 'fetchSupportedModels':
      deps.api
        .sessionSupportedModels(deps.tabId)
        .then((models) => {
          if (models && models.length > 0) deps.setSupportedModels(models);
        })
        .catch((err: unknown) => { deps.onError('fetchSupportedModels', err); });
      return;

    case 'fetchSupportedCommands':
      deps.api
        .sessionSupportedCommands(deps.tabId)
        .then((commands) => {
          if (commands && commands.length > 0) deps.setSupportedCommands(commands);
        })
        .catch((err: unknown) => { deps.onError('fetchSupportedCommands', err); });
      return;

    case 'processQueuedPrompt': {
      const queue = deps.queuedPromptsRef.current;
      if (queue.length === 0) return;
      const [next, ...rest] = queue;
      deps.setQueuedPrompts(rest);
      // The 100ms delay matches the original inline behaviour — gives React a
      // tick to flush the dequeue setState before the next prompt re-enters
      // the send pipeline.
      setTimeout(() => {
        deps.handleSendPrompt(next.prompt, next.model, next.images);
      }, 100);
      return;
    }

    case 'queuePostCompactDirective': {
      const prompt = deps.postCompactPrompt.trim();
      // A blanked override means the user turned the directive off. Honour
      // that rather than sending an empty turn.
      if (!prompt) return;
      const queue = deps.queuedPromptsRef.current;
      // Two boundaries before the queue drains would otherwise stack two
      // identical directives into the same conversation.
      if (queue.some((q) => q.prompt === prompt)) return;
      // Front of the queue, not the back: the directive repairs a lossy
      // summary, and anything the user queued before the compaction would
      // otherwise be answered from exactly the degraded context it repairs.
      const next = [{ prompt, model: deps.currentModel } as Q, ...queue];
      // Write the ref as well as state — processQueuedPrompt reads the ref,
      // and a `result` can land before React has flushed the setState.
      deps.queuedPromptsRef.current = next;
      deps.setQueuedPrompts(next);
      return;
    }

    case 'showPermissionPrompt':
      // Reducer already patched `pendingPermission` into renderer state via
      // the `pendingPermission` field on its result; this effect kind is kept
      // so tests can assert that the reducer "wanted" to show a prompt
      // without inspecting a separate state-shape patch.
      return;
  }
}
