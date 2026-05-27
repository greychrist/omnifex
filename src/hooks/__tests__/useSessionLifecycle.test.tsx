// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React, { useRef, StrictMode } from 'react';
import type { ClaudeStreamMessage } from '@/types/claudeStream';

// ── helpers for constructing minimal ClaudeStreamMessage shapes ──────────────

function makeUserPrompt(overrides: Record<string, unknown> = {}): ClaudeStreamMessage {
  return {
    type: 'user',
    message: { role: 'user', content: 'hello' },
    parent_tool_use_id: null,
    ...overrides,
  } as unknown as ClaudeStreamMessage;
}

function makeAssistantMsg(stop_reason: string | null = null, overrides: Record<string, unknown> = {}): ClaudeStreamMessage {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [], stop_reason },
    parent_tool_use_id: null,
    ...overrides,
  } as unknown as ClaudeStreamMessage;
}

vi.mock('@/lib/api', () => ({
  api: {
    startSession: vi.fn(),
    stopSession: vi.fn().mockResolvedValue(undefined),
    sessionRebind: vi.fn().mockResolvedValue(false),
    sessionGetHealth: vi.fn().mockResolvedValue({ alive: false, sessionId: null, sessionStatus: 'stopped' }),
    sessionAccountInfo: vi.fn().mockResolvedValue(null),
    sessionSupportedModels: vi.fn().mockResolvedValue([]),
    sessionSupportedCommands: vi.fn().mockResolvedValue([]),
    sessionMcpServerStatus: vi.fn().mockResolvedValue([]),
    sessionContextUsage: vi.fn().mockResolvedValue(null),
    resolveAccountForProject: vi.fn().mockResolvedValue(null),
  },
}));

// onEvent listeners get attached on attachStreamListeners. Stash the
// payload callbacks per channel so individual tests can fire them and
// assert downstream behavior.
let eventListeners: Record<string, (payload: unknown) => void>;
beforeEach(() => {
  eventListeners = {};
  (window as any).electronAPI = {
    onEvent: vi.fn((channel: string, cb: (payload: unknown) => void) => {
      eventListeners[channel] = cb;
      // unsubscribe — clear the recorded listener so a subsequent
      // attachStreamListeners can reattach a fresh one.
      return () => {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- bounded by the test's own channel set, not user input.
        delete eventListeners[channel];
      };
    }),
    invoke: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

import { api } from '@/lib/api';
import { useSessionLifecycle } from '../useSessionLifecycle';

interface HarnessOverrides {
  messages?: ClaudeStreamMessage[];
  tasks?: { status: string }[];
  subagents?: { status: string }[];
  initialPersistent?: boolean;
  setIsLoading?: ReturnType<typeof vi.fn>;
  handleJsonlLine?: ReturnType<typeof vi.fn>;
  onSessionInit?: ReturnType<typeof vi.fn>;
}

function harness(overrides: HarnessOverrides = {}) {
  return () => {
    const persistentSessionRef = useRef(overrides.initialPersistent ?? false);
    const messagesRef = useRef<ClaudeStreamMessage[]>(overrides.messages ?? []);

    return {
      lifecycle: useSessionLifecycle({
        tabId: 'tab-life',
        projectPath: '/repo',
        selectedModel: 'sonnet',
        permissionMode: 'default',
        effort: 'medium',
        thinkingConfig: 'adaptive',
        accountResolution: {
          account: { name: 'A', account_type: 'pro', config_dir: '/cfg' },
          match_type: 'override',
          match_detail: '',
        },
        persistentSessionRef,
        handleJsonlLine: (overrides.handleJsonlLine ?? vi.fn()) as any,
        setIsLoading: (overrides.setIsLoading ?? vi.fn()) as any,
        setMessages: ((updater: any) => {
          messagesRef.current = typeof updater === 'function'
            ? updater(messagesRef.current)
            : updater;
        }) as any,
        onSessionInit: (overrides.onSessionInit ?? vi.fn()) as any,
        messages: overrides.messages ?? [],
        tasks: overrides.tasks ?? [],
        subagents: overrides.subagents ?? [],
      }),
      persistentSessionRef,
      messagesRef,
    };
  };
}

describe('useSessionLifecycle — startPersistentSession happy path', () => {
  it('flips Starting badge true, attaches listeners, calls api.startSession with resolved config, and renders no placeholder init', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result } = renderHook(harness());

    await act(async () => {
      await result.current.lifecycle.startPersistentSession();
    });

    expect(api.startSession).toHaveBeenCalledWith(
      'tab-life',
      '/repo',
      'sonnet',
      'default',
      undefined,
      '/cfg',
      'medium',
      { type: 'adaptive' },
      undefined,
      false,
      undefined, // agent — harness doesn't pass one; lifecycle forwards undefined
    );
    expect(result.current.persistentSessionRef.current).toBe(true);
    // Listeners attached on the three agent-* tab-scoped channels plus
    // claude-output-extra (closure carriers) and session-status /
    // session-init (sessionId pinned at spawn).
    expect(Object.keys(eventListeners).sort()).toEqual([
      'agent-complete:tab-life',
      'agent-error:tab-life',
      'agent-output:tab-life',
      'claude-output-extra:tab-life',
      'session-init:tab-life',
      'session-status:tab-life',
    ]);
    // No placeholder init is rendered — the chat stays empty until the
    // SDK iterator yields its real system:init via agent-output.
    expect(result.current.messagesRef.current).toHaveLength(0);
  });

  it('is a no-op when persistentSessionRef is already true', async () => {
    const { result } = renderHook(harness({ initialPersistent: true }));
    await act(async () => {
      await result.current.lifecycle.startPersistentSession();
    });
    expect(api.startSession).not.toHaveBeenCalled();
  });

  it('debounces concurrent calls — two rapid startPersistentSession invocations spawn only one session', async () => {
    // Pending promise so both calls overlap on the await rather than serializing.
    let resolveStart: (v: string) => void = () => {};
    (api.startSession as any).mockImplementationOnce(
      () => new Promise<string>((r) => { resolveStart = r; }),
    );

    const { result } = renderHook(harness());

    await act(async () => {
      // Fire both before either resolves — simulates StrictMode double-mount
      // or a rapid re-render firing the auto-start effect twice.
      const a = result.current.lifecycle.startPersistentSession();
      const b = result.current.lifecycle.startPersistentSession();
      resolveStart('uuid-1');
      await Promise.all([a, b]);
    });

    expect((api.startSession as any).mock.calls.length).toBe(1);
  });

  it('falls back to api.resolveAccountForProject when accountResolution lacks a config_dir', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    // Mirror the widened IPC shape: `{ agent, account }` with the Claude
    // account row nested under `.account`. Pre-Task-12 the resolver
    // returned `Account | null` directly; the hook now reads `.account`.
    (api.resolveAccountForProject as any).mockResolvedValueOnce({
      agent: 'claude',
      account: { config_dir: '/fallback-cfg' },
    });

    // Custom harness with empty accountResolution.
    const useLocalHarness = () => {
      const persistentSessionRef = useRef(false);
      const messagesRef = useRef<ClaudeStreamMessage[]>([]);
      return {
        lifecycle: useSessionLifecycle({
          tabId: 'tab-fb',
          projectPath: '/repo',
          selectedModel: 'sonnet',
          permissionMode: 'default',
          effort: 'medium',
          thinkingConfig: 'adaptive',
          accountResolution: null,
          persistentSessionRef,
          handleJsonlLine: vi.fn(),
          setIsLoading: vi.fn(),
          setMessages: ((updater: any) => {
            messagesRef.current = typeof updater === 'function' ? updater(messagesRef.current) : updater;
          }) as any,
          onSessionInit: vi.fn(),
          messages: [],
          tasks: [],
          subagents: [],
        }),
      };
    };

    const { result } = renderHook(useLocalHarness);
    await act(async () => {
      await result.current.lifecycle.startPersistentSession();
    });
    expect(api.resolveAccountForProject).toHaveBeenCalledWith('/repo');
    expect((api.startSession as any).mock.calls[0][5]).toBe('/fallback-cfg');
  });

  it('passes thinking="disabled" when thinkingConfig is "disabled"', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const useLocal = () => {
      const persistentSessionRef = useRef(false);
      const messagesRef = useRef<ClaudeStreamMessage[]>([]);
      return useSessionLifecycle({
        tabId: 't1', projectPath: '/r', selectedModel: 'sonnet',
        permissionMode: 'default', effort: 'medium', thinkingConfig: 'disabled',
        accountResolution: { account: { name: 'a', account_type: 'pro', config_dir: '/c' }, match_type: 'rule', match_detail: '' },
        persistentSessionRef,
        handleJsonlLine: vi.fn(), setIsLoading: vi.fn(),
        setMessages: ((u: any) => { messagesRef.current = typeof u === 'function' ? u(messagesRef.current) : u; }) as any,
        onSessionInit: vi.fn(),
        messages: [],
        tasks: [],
        subagents: [],
      });
    };
    const { result } = renderHook(useLocal);
    await act(async () => { await result.current.startPersistentSession(); });
    expect((api.startSession as any).mock.calls[0][7]).toEqual({ type: 'disabled' });
  });
});

describe('useSessionLifecycle — startPersistentSession error surface', () => {
  it('appends a synthetic error message and flips sessionStatus to "error" when startSession rejects', async () => {
    (api.startSession as any).mockRejectedValueOnce(
      new Error('No Claude account could be resolved for project'),
    );
    const setIsLoading = vi.fn();
    const { result } = renderHook(harness({ setIsLoading }));

    expect(result.current.lifecycle.sessionStatus).toBe('stopped');
    expect(result.current.messagesRef.current).toHaveLength(0);

    await act(async () => {
      await result.current.lifecycle.startPersistentSession().catch(() => {});
    });

    expect(result.current.lifecycle.sessionStatus).toBe('error');
    expect(setIsLoading).toHaveBeenCalledWith(false);

    const msgs = result.current.messagesRef.current as any[];
    const errMsg = msgs[msgs.length - 1];
    expect(errMsg.type).toBe('system');
    expect(errMsg.subtype).toBe('notification');
    expect(errMsg.notification_type).toBe('error');
    expect(String(errMsg.body)).toMatch(/No Claude account/i);
  });

  it('re-throws so the caller catch can still log', async () => {
    (api.startSession as any).mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(harness());
    let captured: Error | undefined;
    await act(async () => {
      try {
        await result.current.lifecycle.startPersistentSession();
      } catch (e) {
        captured = e as Error;
      }
    });
    expect(captured?.message).toBe('boom');
  });
});

describe('useSessionLifecycle — rebindPersistentSession', () => {
  it('returns true and short-circuits when persistentSessionRef is already true', async () => {
    const { result } = renderHook(harness({ initialPersistent: true }));
    let rebound = false;
    await act(async () => { rebound = await result.current.lifecycle.rebindPersistentSession(); });
    expect(rebound).toBe(true);
    expect(api.sessionRebind).not.toHaveBeenCalled();
  });

  it('returns false when api.sessionRebind reports no live session', async () => {
    (api.sessionRebind as any).mockResolvedValueOnce(false);
    const { result } = renderHook(harness());
    let rebound = true;
    await act(async () => { rebound = await result.current.lifecycle.rebindPersistentSession(); });
    expect(rebound).toBe(false);
    expect(result.current.persistentSessionRef.current).toBe(false);
  });

  it('returns true, attaches listeners, sets persistent flag, and seeds sessionStatus from sessionGetHealth when rebind succeeds', async () => {
    (api.sessionRebind as any).mockResolvedValueOnce(true);
    (api.sessionGetHealth as any).mockResolvedValueOnce({
      alive: true, sessionId: 'uuid-warm', sessionStatus: 'started',
    });
    // No messages → waitingOnClaude([]) = false, no tasks/subagents → derived 'idle'.
    const { result } = renderHook(harness());
    let rebound = false;
    await act(async () => { rebound = await result.current.lifecycle.rebindPersistentSession(); });
    // Flush the post-rebind sessionGetHealth microtask chain.
    await act(async () => { await Promise.resolve(); });
    expect(rebound).toBe(true);
    expect(result.current.persistentSessionRef.current).toBe(true);
    expect(result.current.lifecycle.sessionStatus).toBe('started');
    // conversationStatus is now derived from messages (empty) → 'idle'.
    // Note: the payload's `conversationStatus: 'idle'` is coincidentally the same,
    // but derivation is the source — not the IPC payload.
    expect(result.current.lifecycle.conversationStatus).toBe('idle');
    expect(Object.keys(eventListeners)).toContain('agent-output:tab-life');
    expect(Object.keys(eventListeners)).toContain('session-status:tab-life');
  });

  it('returns false (and logs) when api.sessionRebind rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (api.sessionRebind as any).mockRejectedValueOnce(new Error('rebind fail'));
    const { result } = renderHook(harness());
    let rebound = true;
    await act(async () => { rebound = await result.current.lifecycle.rebindPersistentSession(); });
    expect(rebound).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('useSessionLifecycle — event listener behavior', () => {
  it('forwards agent-output payloads to handleJsonlLine (JSONL pipeline enabled by default)', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const handleJsonlLine = vi.fn();
    const { result } = renderHook(harness({ handleJsonlLine }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    act(() => { eventListeners['agent-output:tab-life']('{"type":"user"}'); });
    expect(handleJsonlLine).toHaveBeenCalledWith('{"type":"user"}');
  });

  it('forwards claude-output-extra (closure carrier channel) to handleJsonlLine', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const handleJsonlLine = vi.fn();
    const { result } = renderHook(harness({ handleJsonlLine }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    const payload = { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>...</task-notification>' };
    act(() => { eventListeners['claude-output-extra:tab-life'](payload); });
    expect(handleJsonlLine).toHaveBeenCalledWith(payload);
  });

  it('ignores benign stderr ("no stdin data received in", "proceeding without it")', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(harness());
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    act(() => { eventListeners['agent-error:tab-life']('no stdin data received in 5s'); });
    act(() => { eventListeners['agent-error:tab-life']('proceeding without it'); });
    expect(errorSpy).not.toHaveBeenCalled();

    // Genuinely unexpected stderr DOES log.
    act(() => { eventListeners['agent-error:tab-life']('SIGSEGV'); });
    expect(errorSpy).toHaveBeenCalledWith('[ClaudeCodeSession] stderr:', 'SIGSEGV');
    errorSpy.mockRestore();
  });

  it('agent-complete clears loading + persistent flag AND disposes all session listeners', async () => {
    // agent-complete is main's authoritative "this session is over" signal.
    // We use it to dispose the per-session IPC listeners so closed tabs don't
    // leak preload-world ipcRenderer subscriptions. In production, main emits
    // session-status:stopped *before* agent-complete (see runtime.ts onExit
    // ordering), so the renderer has already reflected the stopped state by
    // the time the disposal runs.
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const setIsLoading = vi.fn();
    const { result } = renderHook(harness({ setIsLoading }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    expect(result.current.persistentSessionRef.current).toBe(true);

    // Main emits stopped status first; renderer reflects it.
    act(() => { eventListeners['session-status:tab-life']({ sessionStatus: 'stopped' }); });
    expect(result.current.lifecycle.sessionStatus).toBe('stopped');
    expect(result.current.lifecycle.conversationStatus).toBeNull();

    // Then main emits claude-complete; renderer clears state AND disposes
    // its listeners.
    act(() => { eventListeners['agent-complete:tab-life'](undefined); });
    expect(setIsLoading).toHaveBeenCalledWith(false);
    expect(result.current.persistentSessionRef.current).toBe(false);
    // The unsubscribe functions registered with electronAPI.onEvent removed
    // their channel entries from the test's eventListeners map.
    expect(eventListeners['agent-output:tab-life']).toBeUndefined();
    expect(eventListeners['session-status:tab-life']).toBeUndefined();
    expect(eventListeners['session-init:tab-life']).toBeUndefined();
  });
});

describe('useSessionLifecycle — unmount cleanup', () => {
  it('does NOT call api.stopSession on unmount, even when a session was running', async () => {
    // Tear-down responsibility moved to TabContext.removeTab. React unmount
    // alone (Cmd+R reload, StrictMode double-invoke, tab-visibility flips)
    // must not kill a live main-process session — otherwise rebind has
    // nothing to claim. Only explicit tab close should stop sessions.
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result, unmount } = renderHook(harness());
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    expect(result.current.persistentSessionRef.current).toBe(true);

    unmount();
    await new Promise((r) => setTimeout(r, 10));
    expect(api.stopSession).not.toHaveBeenCalled();
  });

  it('does NOT call api.stopSession when no session was started', () => {
    const { unmount } = renderHook(harness());
    unmount();
    expect(api.stopSession).not.toHaveBeenCalled();
  });
});

describe('useSessionLifecycle — session-init event', () => {
  it('invokes onSessionInit with the pinned sessionId when main emits session-init', async () => {
    // The CLI engine pins a UUID at spawn and main forwards it on
    // `session-init:<tabId>` before any stream message arrives. This is
    // how claudeSessionId / extractedSessionInfo get seeded immediately,
    // unlocking UI gated on them (mode toggle, model picker, persistence).
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const onSessionInit = vi.fn();
    const { result } = renderHook(harness({ onSessionInit }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    act(() => {
      eventListeners['session-init:tab-life']({ sessionId: 'uuid-cold-start' });
    });
    expect(onSessionInit).toHaveBeenCalledWith('uuid-cold-start');
  });

  it('rebindPersistentSession re-seeds claudeSessionId via onSessionInit from sessionGetHealth', async () => {
    (api.sessionRebind as any).mockResolvedValueOnce(true);
    (api.sessionGetHealth as any).mockResolvedValueOnce({
      alive: true,
      sessionId: 'uuid-warm',
      sessionStatus: 'started',
    });
    const onSessionInit = vi.fn();
    const { result } = renderHook(harness({ onSessionInit }));
    await act(async () => { await result.current.lifecycle.rebindPersistentSession(); });
    await act(async () => { await Promise.resolve(); });
    expect(onSessionInit).toHaveBeenCalledWith('uuid-warm');
  });
});

describe('useSessionLifecycle — sessionStatus + conversationStatus', () => {
  it('defaults to sessionStatus=stopped, conversationStatus=null before any activity', () => {
    const { result } = renderHook(harness());
    expect(result.current.lifecycle.sessionStatus).toBe('stopped');
    // null when sessionStatus !== 'started' regardless of messages.
    expect(result.current.lifecycle.conversationStatus).toBeNull();
  });

  it('flips sessionStatus to "starting" synchronously when startPersistentSession is called, before IPC resolves', async () => {
    let resolveStart: () => void = () => {};
    (api.startSession as any).mockImplementationOnce(
      () => new Promise<void>((r) => { resolveStart = () => { r(); }; }),
    );
    const { result } = renderHook(harness());

    let p: Promise<void>;
    act(() => { p = result.current.lifecycle.startPersistentSession(); });
    expect(result.current.lifecycle.sessionStatus).toBe('starting');
    // Still null — derivation gates on sessionStatus === 'started'.
    expect(result.current.lifecycle.conversationStatus).toBeNull();

    await act(async () => { resolveStart(); await p!; });
  });

  it('derives conversationStatus="idle" when session is started and messages are empty', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    // No messages, tasks, or subagents → idle.
    const { result } = renderHook(harness({ messages: [], tasks: [], subagents: [] }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    act(() => {
      // Only sessionStatus in the payload — conversationStatus field is discarded.
      eventListeners['session-status:tab-life']({ sessionStatus: 'started' });
    });
    expect(result.current.lifecycle.sessionStatus).toBe('started');
    expect(result.current.lifecycle.conversationStatus).toBe('idle');
  });

  it('derives conversationStatus="running" from messages — user prompt with no assistant reply yet', async () => {
    // Hook starts with a user prompt but no assistant response → waitingOnClaude → running.
    const messages = [makeUserPrompt()];
    const { result } = renderHook(harness({ messages, tasks: [], subagents: [] }));
    // Drive sessionStatus to 'started' via IPC after starting the session.
    (api.startSession as any).mockResolvedValueOnce(undefined);
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started' });
    });
    expect(result.current.lifecycle.conversationStatus).toBe('running');
  });

  it('derives conversationStatus="idle" when last assistant message has a terminal stop_reason', async () => {
    // user prompt + assistant with stop_reason='end_turn' → not waiting → idle.
    const messages = [makeUserPrompt(), makeAssistantMsg('end_turn')];
    const { result } = renderHook(harness({ messages, tasks: [], subagents: [] }));
    (api.startSession as any).mockResolvedValueOnce(undefined);
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started' });
    });
    expect(result.current.lifecycle.conversationStatus).toBe('idle');
  });

  it('derives conversationStatus="running" when an open task exists', async () => {
    const messages = [makeUserPrompt(), makeAssistantMsg('end_turn')];
    const tasks = [{ status: 'in_progress' }];
    const { result } = renderHook(harness({ messages, tasks, subagents: [] }));
    (api.startSession as any).mockResolvedValueOnce(undefined);
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started' });
    });
    // hasOpenTasks returns true for status !== 'completed' → running.
    expect(result.current.lifecycle.conversationStatus).toBe('running');
  });

  it('derives conversationStatus="running" when a subagent is running', async () => {
    const messages = [makeUserPrompt(), makeAssistantMsg('end_turn')];
    const subagents = [{ status: 'running' }];
    const { result } = renderHook(harness({ messages, tasks: [], subagents }));
    (api.startSession as any).mockResolvedValueOnce(undefined);
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started' });
    });
    // hasOpenSubagents: status !== 'completed' → running.
    expect(result.current.lifecycle.conversationStatus).toBe('running');
  });

  it('conversationStatus is null when sessionStatus is not "started", regardless of messages', async () => {
    const messages = [makeUserPrompt()];
    const { result } = renderHook(harness({ messages }));
    // Still stopped — derivation must gate on sessionStatus.
    expect(result.current.lifecycle.conversationStatus).toBeNull();
  });

  it('forces conversationStatus to null when sessionStatus leaves "started" (invariant)', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const messages = [makeUserPrompt()];
    const { result } = renderHook(harness({ messages }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started' });
    });
    // Prompt with no reply → running.
    expect(result.current.lifecycle.conversationStatus).toBe('running');

    // Session transitions to error — derivation must gate and return null.
    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'error' });
    });
    expect(result.current.lifecycle.sessionStatus).toBe('error');
    expect(result.current.lifecycle.conversationStatus).toBeNull();
  });

  it('ignores payloads without a sessionStatus field', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result } = renderHook(harness());
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started' });
    });
    expect(result.current.lifecycle.sessionStatus).toBe('started');
    // With no messages, derivation yields 'idle'.
    expect(result.current.lifecycle.conversationStatus).toBe('idle');

    // Malformed payloads are ignored — sessionStatus stays 'started' and
    // derivation continues to read from messages (still empty → idle).
    act(() => { eventListeners['session-status:tab-life'](undefined); });
    act(() => { eventListeners['session-status:tab-life']({}); });
    expect(result.current.lifecycle.sessionStatus).toBe('started');
    expect(result.current.lifecycle.conversationStatus).toBe('idle');
  });

  it('conversationStatus payload in session-status event is discarded (derivation takes over)', async () => {
    // This is the key Task 2 assertion: even if main still sends a
    // conversationStatus in the IPC payload, the hook ignores it and
    // returns the locally-derived value.
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const messages = [makeUserPrompt()]; // → waitingOnClaude → 'running'
    const { result } = renderHook(harness({ messages }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    act(() => {
      // Emit sessionStatus='started'. The wire format no longer carries
      // conversationStatus — the hook derives it locally from messages.
      // Expect 'running' (derived from the user-prompt-with-no-reply messages),
      // NOT any stale value that an older main-process payload might have sent.
      eventListeners['session-status:tab-life']({ sessionStatus: 'started' });
    });
    expect(result.current.lifecycle.sessionStatus).toBe('started');
    // Derived from messages (user prompt, no assistant) → 'running', NOT 'idle' from payload.
    expect(result.current.lifecycle.conversationStatus).toBe('running');
  });

  it('user message with parent_tool_use_id but plain-text content is classified as prompt, not tool-result', async () => {
    // Regression guard for the old heuristic: a resumed session may carry
    // parent_tool_use_id on a plain user prompt (conversation-tree chaining).
    // That must NOT be mistaken for a tool-result reply or the derivation will
    // skip it and report 'idle' when the session is actually waiting on Claude.
    (api.startSession as any).mockResolvedValueOnce(undefined);
    // Plain-text content — not a tool_result block array.
    const messages = [
      makeUserPrompt({ parent_tool_use_id: 'toolu_abc123', message: { role: 'user', content: 'hello' } }),
    ];
    const { result } = renderHook(harness({ messages, tasks: [], subagents: [] }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started' });
    });
    // The user message must be seen as a prompt → waitingOnClaude → 'running'.
    // If mis-classified as 'tool-result' the derivation would return 'idle'.
    expect(result.current.lifecycle.conversationStatus).toBe('running');
  });

  it('assistant message with parent_tool_use_id and terminal stop_reason is not skipped by waitingOnClaude', async () => {
    // Regression guard for the old isSidechain heuristic: setting isSidechain=true
    // on a main-chain assistant (because parent_tool_use_id was set) would cause
    // waitingOnClaude to skip it and falsely report 'running' when the turn is done.
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const messages = [
      makeUserPrompt(),
      // parent_tool_use_id set but this is a main-chain reply — stop_reason ends the turn.
      makeAssistantMsg('end_turn', { parent_tool_use_id: 'toolu_xyz789' }),
    ];
    const { result } = renderHook(harness({ messages, tasks: [], subagents: [] }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started' });
    });
    // The assistant's stop_reason must end the turn. If isSidechain=true were set
    // the derivation would skip the assistant and see only the unanswered prompt → 'running'.
    expect(result.current.lifecycle.conversationStatus).toBe('idle');
  });
});

describe('useSessionLifecycle — StrictMode-safe', () => {
  // The hook's cleanup no longer calls api.stopSession — tear-down is
  // explicit via TabContext.removeTab on tab close. This test pins that
  // contract: even under StrictMode's setup → cleanup → setup double-invoke,
  // a session that was running stays running. Without that invariant the
  // SDK query gets torn down between the two setups and the new session
  // sits stuck at sessionStatus='starting'.
  it('does not stop the session under StrictMode\'s simulated unmount/remount', async () => {
    renderHook(harness({ initialPersistent: true }), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <StrictMode>{children}</StrictMode>
      ),
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(api.stopSession).not.toHaveBeenCalled();
  });
});
