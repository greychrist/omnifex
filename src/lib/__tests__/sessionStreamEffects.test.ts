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
      sessionSupportedCommands: vi.fn().mockResolvedValue([{ name: '/help' }]),
    },
    persistSession: vi.fn(),
    setSdkAccountInfo: vi.fn(),
    setContextUsage: vi.fn(),
    setSupportedModels: vi.fn(),
    setSupportedCommands: vi.fn(),
    queuedPromptsRef: { current: [] },
    setQueuedPrompts: vi.fn(),
    turnRunningRef: { current: false },
    handleSendPrompt: vi.fn(),
    postCompactPrompt: 'RE-READ: your summary is lossy.',
    currentModel: 'opus',
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
    await vi.waitFor(() => { expect(setSdkAccountInfo).toHaveBeenCalled(); });
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
    await vi.waitFor(() => { expect(setContextUsage).toHaveBeenCalled(); });
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
    await vi.waitFor(() => { expect(setSupportedModels).toHaveBeenCalled(); });
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
    vi.advanceTimersByTime(150);
    expect(setQueuedPrompts).toHaveBeenCalledWith([tail]);
    expect(handleSendPrompt).toHaveBeenCalledWith('hello', 'opus', undefined);
    vi.useRealTimers();
  });

  // The drain is now triggered from more than one place (a `result` row AND a
  // compact_boundary), so it has to be safe to fire mid-turn. Dequeuing and
  // letting handleSendPrompt re-enqueue would push the head to the BACK of the
  // queue — which is exactly what the post-compact directive's front-of-queue
  // placement exists to prevent.
  it('processQueuedPrompt leaves the queue untouched while a turn is in flight', () => {
    vi.useFakeTimers();
    const handleSendPrompt = vi.fn();
    const setQueuedPrompts = vi.fn();
    const directive = { prompt: 'RE-READ', model: 'opus' };
    const typed = { prompt: 'what next?', model: 'opus' };
    const queuedPromptsRef = { current: [directive, typed] };
    const deps = makeDeps({
      handleSendPrompt,
      setQueuedPrompts,
      queuedPromptsRef,
      turnRunningRef: { current: true },
    });
    runStreamEffect({ kind: 'processQueuedPrompt' }, deps);
    vi.advanceTimersByTime(150);
    expect(handleSendPrompt).not.toHaveBeenCalled();
    expect(setQueuedPrompts).not.toHaveBeenCalled();
    expect(queuedPromptsRef.current).toEqual([directive, typed]);
    vi.useRealTimers();
  });

  // Work session 3445e547: the CLI emitted the turn's `result` BEFORE the
  // compact_boundary, so the directive was queued after the only drain trigger
  // had already fired and sat there forever. The boundary now drains too, and
  // by then the turn is over — so the directive must actually go out.
  it('processQueuedPrompt drains a directive queued after the turn ended', () => {
    vi.useFakeTimers();
    const handleSendPrompt = vi.fn();
    const setQueuedPrompts = vi.fn();
    const directive = { prompt: 'RE-READ', model: 'opus' };
    const queuedPromptsRef = { current: [directive] };
    const deps = makeDeps({
      handleSendPrompt,
      setQueuedPrompts,
      queuedPromptsRef,
      turnRunningRef: { current: false },
    });
    runStreamEffect({ kind: 'processQueuedPrompt' }, deps);
    vi.advanceTimersByTime(150);
    expect(handleSendPrompt).toHaveBeenCalledWith('RE-READ', 'opus', undefined);
    expect(queuedPromptsRef.current).toEqual([]);
    vi.useRealTimers();
  });

  it('processQueuedPrompt forwards images attached to the queued prompt', () => {
    vi.useFakeTimers();
    const handleSendPrompt = vi.fn();
    const setQueuedPrompts = vi.fn();
    const images = ['data:image/png;base64,AAAA'];
    const head = { prompt: 'look at this', model: 'opus', images };
    const deps = makeDeps({
      handleSendPrompt,
      setQueuedPrompts,
      queuedPromptsRef: { current: [head] },
    });
    runStreamEffect({ kind: 'processQueuedPrompt' }, deps);
    vi.advanceTimersByTime(150);
    expect(handleSendPrompt).toHaveBeenCalledWith('look at this', 'opus', images);
    vi.useRealTimers();
  });

  it('showPermissionPrompt is a noop (handled via reducer state patch)', () => {
    const deps = makeDeps();
    expect(() =>
      { runStreamEffect(
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
      ); },
    ).not.toThrow();
  });

  describe('queuePostCompactDirective', () => {
    it('queues the directive as a prompt at the current model', () => {
      const setQueuedPrompts = vi.fn();
      const deps = makeDeps({ setQueuedPrompts });
      runStreamEffect({ kind: 'queuePostCompactDirective' }, deps);
      expect(setQueuedPrompts).toHaveBeenCalledWith([
        { prompt: 'RE-READ: your summary is lossy.', model: 'opus' },
      ]);
    });

    it('lands ahead of prompts the user queued before the compaction', () => {
      // The directive exists to correct a lossy summary *before* any further
      // work runs against it. Appending would let the user's next prompt be
      // answered from exactly the degraded context this is meant to repair.
      const setQueuedPrompts = vi.fn();
      const queuedPromptsRef = { current: [{ prompt: 'ship it', model: 'opus' }] };
      const deps = makeDeps({ setQueuedPrompts, queuedPromptsRef });
      runStreamEffect({ kind: 'queuePostCompactDirective' }, deps);
      expect(setQueuedPrompts).toHaveBeenCalledWith([
        { prompt: 'RE-READ: your summary is lossy.', model: 'opus' },
        { prompt: 'ship it', model: 'opus' },
      ]);
    });

    it('keeps the ref in sync so a same-tick queue drain sees the directive', () => {
      // processQueuedPrompt reads queuedPromptsRef.current, not React state.
      const queuedPromptsRef = { current: [] as { prompt: string; model: string }[] };
      const deps = makeDeps({ queuedPromptsRef });
      runStreamEffect({ kind: 'queuePostCompactDirective' }, deps);
      expect(queuedPromptsRef.current).toEqual([
        { prompt: 'RE-READ: your summary is lossy.', model: 'opus' },
      ]);
    });

    it('does not double-queue when a directive is already pending', () => {
      const setQueuedPrompts = vi.fn();
      const queuedPromptsRef = {
        current: [{ prompt: 'RE-READ: your summary is lossy.', model: 'opus' }],
      };
      const deps = makeDeps({ setQueuedPrompts, queuedPromptsRef });
      runStreamEffect({ kind: 'queuePostCompactDirective' }, deps);
      expect(setQueuedPrompts).not.toHaveBeenCalled();
      expect(queuedPromptsRef.current).toHaveLength(1);
    });

    it('sends nothing when the resolved directive is empty', () => {
      const setQueuedPrompts = vi.fn();
      const deps = makeDeps({ setQueuedPrompts, postCompactPrompt: '  ' });
      runStreamEffect({ kind: 'queuePostCompactDirective' }, deps);
      expect(setQueuedPrompts).not.toHaveBeenCalled();
    });
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
    await vi.waitFor(() => { expect(onError).toHaveBeenCalled(); });
    expect(onError.mock.calls[0][0]).toBe('fetchAccountInfo');
    expect((onError.mock.calls[0][1] as Error).message).toBe('boom');
  });
});
