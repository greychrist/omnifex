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

function makeHarness(initialTurnRunning: boolean, onSideChat?: (question: string) => void) {
  return () => {
    const persistentSessionRef = useRef(true);
    const unlistenRefs = useRef<(() => void)[]>([]);
    const turnRunningRef = useRef(initialTurnRunning);
    const sessionMetrics = useRef({
      promptsSent: 0,
      lastActivityTime: 0,
      firstMessageTime: null as number | null,
      modelChanges: [] as { from: string; to: string; timestamp: number }[],
      wasResumed: false,
    });
    const [, setError] = useState<string | null>(null);
    const [, setCurrentActivity] = useState('');
    const [, setSelectedModel] = useState('opus');
    const [, setMessages] = useState<any[]>([]);
    const hook = useSendPrompt({
      projectPath: '/repo',
      tabId: 'tab-1',
      turnRunningRef,
      selectedModel: 'opus',
      persistentSessionRef,
      unlistenRefs,
      effectiveSession: null,
      claudeSessionId: null,
      sessionMetrics,
      startPersistentSession: vi.fn().mockResolvedValue(undefined),
      pickGerund: () => 'thinking',
      setError,
      setCurrentActivity,
      setSelectedModel,
      setMessages,
      onSideChat,
    });
    return { hook, turnRunningRef };
  };
}

describe('useSendPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queues a prompt (with images) while the session reports a running turn', async () => {
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

  it('reads turnRunningRef.current at call-time, not from a captured render', async () => {
    // Reproduces the stale-closure bug: the queue drain path holds onto
    // handleSendPrompt across renders and invokes it later. With a ref-based
    // gate, flipping turnRunningRef.current to false makes the very next call
    // dispatch instead of re-queueing — even though no rerender happened.
    const { result } = renderHook(makeHarness(true));

    // Stale capture: grab the function while the turn was running.
    const stale = result.current.hook.handleSendPrompt;

    // The session's turn closes (mirrored into the ref by AgentSession). No
    // rerender of the hook needed.
    act(() => {
      result.current.turnRunningRef.current = false;
    });

    await act(async () => {
      await stale('drain', 'opus');
    });
    expect(api.sendMessage).toHaveBeenCalledWith('tab-1', 'drain');
    expect(result.current.hook.queuedPrompts).toHaveLength(0);
  });

  it('queues a second prompt while the first send is still in flight, before the session has opened the turn', async () => {
    // The turn opens in main when the prompt is handed over; until that
    // round-trip lands the ref still reads idle. A send in progress is its
    // own fact, owned here, and it must gate exactly like a running turn.
    let release!: () => void;
    (api.sendMessage as any).mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const { result } = renderHook(makeHarness(false));
    let first!: Promise<void>;
    act(() => { first = result.current.hook.handleSendPrompt('one', 'opus'); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await result.current.hook.handleSendPrompt('two', 'opus'); });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.current.hook.queuedPrompts.map((q) => q.prompt)).toEqual(['two']);
    release();
    await act(async () => { await first; });
    // Once the send has landed the latch drops; a further prompt goes straight out.
    await act(async () => { await result.current.hook.handleSendPrompt('three', 'opus'); });
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
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

  // `/btw` is the side chat, never a prompt. This hook is the only place a
  // prompt is queued, so the check lives here — ahead of the queue — and no
  // entry path (composer, resend, queue drain, launch prompt) can queue one.
  describe('/btw', () => {
    it('routes /btw <q> to the side chat during a running turn, queueing nothing', async () => {
      const onSideChat = vi.fn();
      const { result } = renderHook(makeHarness(true, onSideChat));
      await act(async () => {
        await result.current.hook.handleSendPrompt('/btw foo', 'opus');
      });
      expect(onSideChat).toHaveBeenCalledWith('foo');
      expect(result.current.hook.queuedPrompts).toHaveLength(0);
      expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it('routes a bare /btw mid-turn as an open with nothing to ask', async () => {
      const onSideChat = vi.fn();
      const { result } = renderHook(makeHarness(true, onSideChat));
      await act(async () => {
        await result.current.hook.handleSendPrompt('/btw', 'opus');
      });
      expect(onSideChat).toHaveBeenCalledWith('');
      expect(result.current.hook.queuedPrompts).toHaveLength(0);
    });

    it('routes /btw <q> when idle too, sending nothing to the CLI', async () => {
      const onSideChat = vi.fn();
      const { result } = renderHook(makeHarness(false, onSideChat));
      await act(async () => {
        await result.current.hook.handleSendPrompt('/btw foo', 'opus');
      });
      expect(onSideChat).toHaveBeenCalledWith('foo');
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(api.sendStructuredMessage).not.toHaveBeenCalled();
    });

    it('leaves /btw alone when there is no side chat (Codex): it queues like any prompt', async () => {
      const { result } = renderHook(makeHarness(true));
      await act(async () => {
        await result.current.hook.handleSendPrompt('/btw foo', 'opus');
      });
      expect(result.current.hook.queuedPrompts.map((q) => q.prompt)).toEqual(['/btw foo']);
    });
  });
});
