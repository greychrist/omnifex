import type { StreamReducerEffect } from './sessionStreamReducer';

export interface StreamEffectApi {
  sessionAccountInfo(tabId: string): Promise<unknown>;
  sessionContextUsage(tabId: string): Promise<unknown>;
  sessionSupportedModels(tabId: string): Promise<unknown[] | null>;
  sessionSupportedCommands(tabId: string): Promise<unknown[] | null>;
}

export interface QueuedPrompt {
  id: string;
  prompt: string;
  model: string;
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
  /** Read at commit time, after the settle delay: React hasn't flushed the idle-turn mirror when effects run. */
  turnRunningRef: { current: boolean };
  /** When it is the head the queue waits: sending it would send text the user is replacing. */
  editingPromptIdRef?: { current: string | null };
  /** After a Stop the queue waits for the user instead of draining on the next idle turn. */
  queueHeldRef?: { current: boolean };
  handleSendPrompt: (prompt: string, model: string, images?: string[]) => void;
  postCompactPrompt: string;
  currentModel: string;
  onError: (kind: StreamReducerEffect['kind'], err: unknown) => void;
}

export function withoutQueuedImage<Q extends QueuedPrompt>(queue: Q[], id: string, index: number): Q[] {
  return queue.map((p) => {
    if (p.id !== id || !p.images) return p;
    const images = p.images.filter((_, i) => i !== index);
    if (images.length > 0) return { ...p, images };
    const { images: _dropped, ...rest } = p;
    return rest as Q;
  });
}

export function newQueuedPromptId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

export function drainQueuedPrompt<Q extends QueuedPrompt>(
  deps: Pick<
    StreamEffectDeps<Q>,
    'queuedPromptsRef' | 'setQueuedPrompts' | 'turnRunningRef' | 'editingPromptIdRef' | 'queueHeldRef' | 'handleSendPrompt'
  >,
): void {
  // Peek, then commit: this fires mid-turn too, and dequeue + re-enqueue would push the post-compact directive off the front.
  if (deps.turnRunningRef.current || deps.queueHeldRef?.current) return;
  const queue = deps.queuedPromptsRef.current;
  if (queue.length === 0) return;
  const [next, ...rest] = queue;
  const editing = deps.editingPromptIdRef?.current;
  if (editing != null && editing === next.id) return;
  // Write the ref too: a second trigger can arrive before React flushes.
  deps.queuedPromptsRef.current = rest;
  deps.setQueuedPrompts(rest);
  deps.handleSendPrompt(next.prompt, next.model, next.images);
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
      if (deps.queuedPromptsRef.current.length === 0) return;
      // Lets React flush the idle-turn announcement that follows the result row.
      setTimeout(() => { drainQueuedPrompt(deps); }, 100);
      return;
    }

    case 'queuePostCompactDirective': {
      const prompt = deps.postCompactPrompt.trim();
      // '' means the user switched the directive off (postCompact.enabled).
      if (!prompt) return;
      const queue = deps.queuedPromptsRef.current;
      if (queue.some((q) => q.prompt === prompt)) return;
      // Front of the queue: prompts queued before compaction must not be answered from the lossy context.
      const directive = { id: newQueuedPromptId(), prompt, model: deps.currentModel } as Q;
      const next = [directive, ...queue];
      // Write the ref too: a result can land before React flushes.
      deps.queuedPromptsRef.current = next;
      deps.setQueuedPrompts(next);
      return;
    }

    case 'showPermissionPrompt':
      return;
  }
}
