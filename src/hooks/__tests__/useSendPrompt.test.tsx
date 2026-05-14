// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useRef, useState } from 'react';

vi.mock('@/lib/api', () => ({
  api: {
    sessionSetModel: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendStructuredMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

import { api } from '@/lib/api';
import { useSendPrompt } from '../useSendPrompt';

function makeHarness(initialIsLoading: boolean) {
  return () => {
    const persistentSessionRef = useRef(true);
    const unlistenRefs = useRef<(() => void)[]>([]);
    const isLoadingRef = useRef(initialIsLoading);
    const sessionMetrics = useRef({
      promptsSent: 0,
      lastActivityTime: 0,
      firstMessageTime: null as number | null,
      modelChanges: [] as { from: string; to: string; timestamp: number }[],
      wasResumed: false,
    });
    const [, setIsLoading] = useState(initialIsLoading);
    const [, setError] = useState<string | null>(null);
    const [, setCurrentActivity] = useState('');
    const [, setSelectedModel] = useState('opus');
    const [, setMessages] = useState<any[]>([]);
    const hook = useSendPrompt({
      projectPath: '/repo',
      tabId: 'tab-1',
      isLoadingRef,
      selectedModel: 'opus',
      persistentSessionRef,
      unlistenRefs,
      effectiveSession: null,
      claudeSessionId: null,
      sessionMetrics,
      startPersistentSession: vi.fn().mockResolvedValue(undefined),
      pickGerund: () => 'thinking',
      setIsLoading,
      setError,
      setCurrentActivity,
      setSelectedModel,
      setMessages,
    });
    return { hook, isLoadingRef };
  };
}

describe('useSendPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queues a prompt (with images) when isLoadingRef.current is true', async () => {
    const { result } = renderHook(makeHarness(true));
    await act(async () => {
      await result.current.hook.handleSendPrompt('queued', 'opus', ['data:image/png;base64,AAAA']);
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.sendStructuredMessage).not.toHaveBeenCalled();
    expect(result.current.hook.queuedPrompts).toHaveLength(1);
    expect(result.current.hook.queuedPrompts[0].prompt).toBe('queued');
    expect(result.current.hook.queuedPrompts[0].images).toEqual(['data:image/png;base64,AAAA']);
  });

  it('reads isLoadingRef.current at call-time, not from a captured render', async () => {
    // Reproduces the stale-closure bug: the queue drain path holds onto
    // handleSendPrompt across renders and invokes it later. With a ref-based
    // gate, flipping isLoadingRef.current to false makes the very next call
    // dispatch instead of re-queueing — even though no rerender happened.
    const { result } = renderHook(makeHarness(true));

    // Stale capture: grab the function while isLoading was true.
    const stale = result.current.hook.handleSendPrompt;

    // Caller flips the ref to false (mirroring `setIsLoading(false)` + sync
    // effect in ClaudeCodeSession). No rerender of the hook needed.
    act(() => {
      result.current.isLoadingRef.current = false;
    });

    await act(async () => {
      await stale('drain', 'opus');
    });
    expect(api.sendMessage).toHaveBeenCalledWith('tab-1', 'drain');
    expect(result.current.hook.queuedPrompts).toHaveLength(0);
  });

  it('passes images through as structured content blocks when sending', async () => {
    const { result } = renderHook(makeHarness(false));
    await act(async () => {
      await result.current.hook.handleSendPrompt('see image', 'opus', [
        'data:image/png;base64,ZZZZ',
      ]);
    });
    expect(api.sendStructuredMessage).toHaveBeenCalledTimes(1);
    const [, blocks] = (api.sendStructuredMessage as any).mock.calls[0];
    expect(blocks).toEqual([
      { type: 'text', text: 'see image' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZZZZ' } },
    ]);
  });

  afterEach(() => { cleanup(); });
});
