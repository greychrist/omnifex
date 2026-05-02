import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runStreamEffect,
  type StreamEffectDeps,
} from '../sessionStreamEffects';
import type { StreamReducerEffect } from '../sessionStreamReducer';

function makeDeps(overrides: Partial<StreamEffectDeps> = {}): StreamEffectDeps {
  return {
    tabId: 'tab-1',
    projectPath: '/Users/me/repo',
    api: {
      sessionAccountInfo: vi.fn().mockResolvedValue({ name: 'me' }),
      sessionContextUsage: vi.fn().mockResolvedValue({ used: 1 }),
      sessionSupportedModels: vi.fn().mockResolvedValue([{ id: 'm1', name: 'm' }]),
    },
    persistSession: vi.fn(),
    setSdkAccountInfo: vi.fn(),
    setContextUsage: vi.fn(),
    setSupportedModels: vi.fn(),
    queuedPromptsRef: { current: [] },
    setQueuedPrompts: vi.fn(),
    handleSendPrompt: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('runStreamEffect', () => {
  beforeEach(() => vi.useRealTimers());

  it('saveSessionPersistence calls persistSession with effect data', () => {
    const persistSession = vi.fn();
    const deps = makeDeps({ persistSession });
    const effect: StreamReducerEffect = {
      kind: 'saveSessionPersistence',
      sessionId: 'sess-1',
      projectId: 'proj-1',
      messageCount: 4,
    };
    runStreamEffect(effect, deps);
    expect(persistSession).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      projectId: 'proj-1',
      projectPath: '/Users/me/repo',
      messageCount: 4,
    });
  });

  it('fetchAccountInfo calls api and sets state on success', async () => {
    const setSdkAccountInfo = vi.fn();
    const sessionAccountInfo = vi.fn().mockResolvedValue({ name: 'gregory' });
    const deps = makeDeps({
      setSdkAccountInfo,
      api: { ...makeDeps().api, sessionAccountInfo },
    });
    runStreamEffect({ kind: 'fetchAccountInfo' }, deps);
    await vi.waitFor(() => expect(setSdkAccountInfo).toHaveBeenCalled());
    expect(sessionAccountInfo).toHaveBeenCalledWith('tab-1');
    expect(setSdkAccountInfo).toHaveBeenCalledWith({ name: 'gregory' });
  });

  it('fetchAccountInfo does not call setter when api returns null', async () => {
    const setSdkAccountInfo = vi.fn();
    const deps = makeDeps({
      setSdkAccountInfo,
      api: { ...makeDeps().api, sessionAccountInfo: vi.fn().mockResolvedValue(null) },
    });
    runStreamEffect({ kind: 'fetchAccountInfo' }, deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(setSdkAccountInfo).not.toHaveBeenCalled();
  });

  it('refreshContextUsage calls api and sets state on success', async () => {
    const setContextUsage = vi.fn();
    const sessionContextUsage = vi.fn().mockResolvedValue({ used: 42 });
    const deps = makeDeps({
      setContextUsage,
      api: { ...makeDeps().api, sessionContextUsage },
    });
    runStreamEffect({ kind: 'refreshContextUsage' }, deps);
    await vi.waitFor(() => expect(setContextUsage).toHaveBeenCalled());
    expect(sessionContextUsage).toHaveBeenCalledWith('tab-1');
    expect(setContextUsage).toHaveBeenCalledWith({ used: 42 });
  });

  it('fetchSupportedModels only sets state when models array is non-empty', async () => {
    const setSupportedModels = vi.fn();
    const deps = makeDeps({
      setSupportedModels,
      api: {
        ...makeDeps().api,
        sessionSupportedModels: vi.fn().mockResolvedValue([]),
      },
    });
    runStreamEffect({ kind: 'fetchSupportedModels' }, deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(setSupportedModels).not.toHaveBeenCalled();
  });

  it('fetchSupportedModels sets state when models array has entries', async () => {
    const setSupportedModels = vi.fn();
    const models = [{ id: 'opus', name: 'Opus' }];
    const deps = makeDeps({
      setSupportedModels,
      api: {
        ...makeDeps().api,
        sessionSupportedModels: vi.fn().mockResolvedValue(models),
      },
    });
    runStreamEffect({ kind: 'fetchSupportedModels' }, deps);
    await vi.waitFor(() => expect(setSupportedModels).toHaveBeenCalled());
    expect(setSupportedModels).toHaveBeenCalledWith(models);
  });

  it('processQueuedPrompt is a noop when the queue is empty', () => {
    const handleSendPrompt = vi.fn();
    const setQueuedPrompts = vi.fn();
    const deps = makeDeps({
      handleSendPrompt,
      setQueuedPrompts,
      queuedPromptsRef: { current: [] },
    });
    runStreamEffect({ kind: 'processQueuedPrompt' }, deps);
    expect(handleSendPrompt).not.toHaveBeenCalled();
    expect(setQueuedPrompts).not.toHaveBeenCalled();
  });

  it('processQueuedPrompt dequeues head and dispatches via handleSendPrompt', async () => {
    vi.useFakeTimers();
    const handleSendPrompt = vi.fn();
    const setQueuedPrompts = vi.fn();
    const head = { prompt: 'hello', model: 'opus' };
    const tail = { prompt: 'world', model: 'sonnet' };
    const deps = makeDeps({
      handleSendPrompt,
      setQueuedPrompts,
      queuedPromptsRef: { current: [head, tail] },
    });
    runStreamEffect({ kind: 'processQueuedPrompt' }, deps);
    expect(setQueuedPrompts).toHaveBeenCalledWith([tail]);
    vi.advanceTimersByTime(150);
    expect(handleSendPrompt).toHaveBeenCalledWith('hello', 'opus');
    vi.useRealTimers();
  });

  it('showPermissionPrompt is a noop (handled via reducer state patch)', () => {
    const deps = makeDeps();
    expect(() =>
      runStreamEffect(
        {
          kind: 'showPermissionPrompt',
          payload: {
            requestId: 'r1',
            toolName: 'Bash',
            toolInput: {},
            suggestions: [],
          },
        },
        deps,
      ),
    ).not.toThrow();
  });

  it('fire-and-forget effects swallow rejections via onError', async () => {
    const onError = vi.fn();
    const deps = makeDeps({
      onError,
      api: {
        ...makeDeps().api,
        sessionAccountInfo: vi.fn().mockRejectedValue(new Error('boom')),
      },
    });
    runStreamEffect({ kind: 'fetchAccountInfo' }, deps);
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toBe('fetchAccountInfo');
    expect((onError.mock.calls[0][1] as Error).message).toBe('boom');
  });
});
