// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React, { useRef, StrictMode } from 'react';
import type { JsonlNode } from '@/types/jsonl';

function makeUserPrompt(overrides: Record<string, unknown> = {}): JsonlNode {
  return {
    kind: 'user',
    userKind: 'prompt',
    sessionId: '',
    receivedAt: '',
    raw: {
      type: 'user',
      message: { role: 'user', content: 'hello' },
      ...overrides,
    },
  } as unknown as JsonlNode;
}

function makeAssistantMsg(stop_reason: string | null = null, overrides: Record<string, unknown> = {}): JsonlNode {
  return {
    kind: 'assistant',
    sessionId: '',
    receivedAt: '',
    raw: {
      type: 'assistant',
      message: { role: 'assistant', content: [], stop_reason },
      ...overrides,
    },
  } as unknown as JsonlNode;
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
    resolveAccountForProject: vi.fn().mockResolvedValue({ claude: null, codex: null }),
  },
}));

let eventListeners: Record<string, (payload: unknown) => void>;
beforeEach(() => {
  eventListeners = {};
  (window as any).electronAPI = {
    onEvent: vi.fn((channel: string, cb: (payload: unknown) => void) => {
      eventListeners[channel] = cb;
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
  messages?: JsonlNode[];
  tasks?: { status: string }[];
  subagents?: { status: string }[];
  initialPersistent?: boolean;
  handleJsonlLine?: ReturnType<typeof vi.fn>;
  onSessionInit?: ReturnType<typeof vi.fn>;
  onLivePermissionMode?: ReturnType<typeof vi.fn>;
}

function harness(overrides: HarnessOverrides = {}) {
  return () => {
    const persistentSessionRef = useRef(overrides.initialPersistent ?? false);
    const messagesRef = useRef<JsonlNode[]>(overrides.messages ?? []);

    return {
      lifecycle: useSessionLifecycle({
        tabId: 'tab-life',
        projectPath: '/repo',
        selectedModel: 'sonnet',
        permissionMode: 'default',
        effort: 'medium',
        accountResolution: {
          account: { name: 'A', subscription_label: 'pro', config_dir: '/cfg' },
          match_type: 'override',
          match_detail: '',
        },
        persistentSessionRef,
        handleJsonlLine: (overrides.handleJsonlLine ?? vi.fn()) as any,
        setMessages: ((updater: any) => {
          messagesRef.current = typeof updater === 'function'
            ? updater(messagesRef.current)
            : updater;
        }) as any,
        onSessionInit: (overrides.onSessionInit ?? vi.fn()) as any,
        onLivePermissionMode: (overrides.onLivePermissionMode ?? vi.fn()) as any,
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
      false,
      undefined, // agent — harness doesn't pass one; lifecycle forwards undefined
    );
    expect(result.current.persistentSessionRef.current).toBe(true);
    expect(Object.keys(eventListeners).sort()).toEqual([
      'agent-complete:tab-life',
      'agent-error:tab-life',
      'agent-output:tab-life',
      'claude-output-extra:tab-life',
      'session-init:tab-life',
      'session-status:tab-life',
      'session-turn:tab-life',
    ]);
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
    let resolveStart: (v: string) => void = () => {};
    (api.startSession as any).mockImplementationOnce(
      () => new Promise<string>((r) => { resolveStart = r; }),
    );

    const { result } = renderHook(harness());

    await act(async () => {
      const a = result.current.lifecycle.startPersistentSession();
      const b = result.current.lifecycle.startPersistentSession();
      resolveStart('uuid-1');
      await Promise.all([a, b]);
    });

    expect((api.startSession as any).mock.calls.length).toBe(1);
  });

  it('falls back to api.resolveAccountForProject when accountResolution lacks a config_dir', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    (api.resolveAccountForProject as any).mockResolvedValueOnce({
      claude: { account: { config_dir: '/fallback-cfg' }, matchType: 'path_rule', matchDetail: '/repo' },
      codex: null,
    });

    const useLocalHarness = () => {
      const persistentSessionRef = useRef(false);
      const messagesRef = useRef<JsonlNode[]>([]);
      return {
        lifecycle: useSessionLifecycle({
          tabId: 'tab-fb',
          projectPath: '/repo',
          selectedModel: 'sonnet',
          permissionMode: 'default',
          effort: 'medium',
            accountResolution: null,
          persistentSessionRef,
          handleJsonlLine: vi.fn(),
          setMessages: ((updater: any) => {
            messagesRef.current = typeof updater === 'function' ? updater(messagesRef.current) : updater;
          }) as any,
          onSessionInit: vi.fn(),
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
});

describe('useSessionLifecycle — startPersistentSession error surface', () => {
  it('appends a synthetic error message and flips sessionStatus to "error" when startSession rejects', async () => {
    (api.startSession as any).mockRejectedValueOnce(
      new Error('No Claude account could be resolved for project'),
    );
    const { result } = renderHook(harness());

    expect(result.current.lifecycle.sessionStatus).toBe('stopped');
    expect(result.current.messagesRef.current).toHaveLength(0);

    await act(async () => {
      await result.current.lifecycle.startPersistentSession().catch(() => {});
    });

    expect(result.current.lifecycle.sessionStatus).toBe('error');
    expect(result.current.lifecycle.turn.status).toBe('idle');

    const msgs = result.current.messagesRef.current as any[];
    const errMsg = msgs[msgs.length - 1];
    expect(errMsg.kind).toBe('system');
    expect(errMsg.subtype).toBe('notification');
    expect(errMsg.raw.notification_type).toBe('error');
    expect(String(errMsg.raw.body)).toMatch(/No Claude account/i);
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

describe('useSessionLifecycle — session died with the daemon', () => {
  afterEach(() => { delete (window as any).__omnifexRemote; });

  it('clears the stale live-session flag and rebinds when the shim reports the session died', async () => {
    (window as any).__omnifexRemote = { client: {} };
    (api.sessionRebind as any).mockResolvedValueOnce(true);
    const { result } = renderHook(harness({ initialPersistent: true }));

    expect(Object.keys(eventListeners)).toContain('remote-session-died:tab-life');
    await act(async () => {
      eventListeners['remote-session-died:tab-life']({ sessionId: 'sid-1' });
      await Promise.resolve();
    });

    expect(api.sessionRebind).toHaveBeenCalledWith('tab-life');
    expect(result.current.persistentSessionRef.current).toBe(true);
  });

  it('does not subscribe outside remote mode, where the channel does not exist', () => {
    renderHook(harness());
    expect(Object.keys(eventListeners)).not.toContain('remote-session-died:tab-life');
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
    const { result } = renderHook(harness());
    let rebound = false;
    await act(async () => { rebound = await result.current.lifecycle.rebindPersistentSession(); });
    // Flush the post-rebind sessionGetHealth microtask chain.
    await act(async () => { await Promise.resolve(); });
    expect(rebound).toBe(true);
    expect(result.current.persistentSessionRef.current).toBe(true);
    expect(result.current.lifecycle.sessionStatus).toBe('started');
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

    act(() => { eventListeners['agent-error:tab-life']('SIGSEGV'); });
    expect(errorSpy).toHaveBeenCalledWith('[ClaudeCodeSession] stderr:', 'SIGSEGV');
    errorSpy.mockRestore();
  });

  it('agent-complete clears loading + persistent flag AND disposes all session listeners', async () => {
    // The daemon emits session-status:stopped before agent-complete.
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result } = renderHook(harness());
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    expect(result.current.persistentSessionRef.current).toBe(true);

    act(() => { eventListeners['session-status:tab-life']({ sessionStatus: 'stopped' }); });
    expect(result.current.lifecycle.sessionStatus).toBe('stopped');
    expect(result.current.lifecycle.conversationStatus).toBeNull();

    act(() => { eventListeners['agent-complete:tab-life'](undefined); });
    expect(result.current.lifecycle.turn.status).toBe('idle');
    expect(result.current.persistentSessionRef.current).toBe(false);
    expect(eventListeners['agent-output:tab-life']).toBeUndefined();
    expect(eventListeners['session-status:tab-life']).toBeUndefined();
    expect(eventListeners['session-init:tab-life']).toBeUndefined();
  });
});

describe('useSessionLifecycle — unmount cleanup', () => {
  it('does NOT call api.stopSession on unmount, even when a session was running', async () => {
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
    // The CLI engine pins a UUID at spawn, forwarded on `session-init:<tabId>`
    // before any stream message.
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

describe('useSessionLifecycle — the turn axis is the session\'s, mirrored', () => {
  function truncatedTranscript(): JsonlNode[] {
    return [makeUserPrompt(), makeAssistantMsg('tool_use')];
  }

  it('reads idle on a resumed transcript that ends mid-turn — the new process is not working', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result } = renderHook(harness({ messages: truncatedTranscript() }));
    await act(async () => { await result.current.lifecycle.startPersistentSession('sid-old'); });
    act(() => { eventListeners['session-status:tab-life']({ sessionStatus: 'started' }); });
    expect(result.current.lifecycle.turn).toEqual({ status: 'idle', since: null });
    expect(result.current.lifecycle.conversationStatus).toBe('idle');
  });

  it('follows session-turn events and exposes them as conversationStatus', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result } = renderHook(harness());
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    act(() => { eventListeners['session-status:tab-life']({ sessionStatus: 'started' }); });
    const running = { status: 'running', since: '2026-09-20T00:00:00.000Z' };
    act(() => { eventListeners['session-turn:tab-life'](running); });
    expect(result.current.lifecycle.turn).toEqual(running);
    expect(result.current.lifecycle.conversationStatus).toBe('running');
    act(() => { eventListeners['session-turn:tab-life']({ status: 'idle', since: null }); });
    expect(result.current.lifecycle.conversationStatus).toBe('idle');
  });

  it('seeds the turn from sessionGetHealth on rebind', async () => {
    (api.sessionRebind as any).mockResolvedValueOnce(true);
    (api.sessionGetHealth as any).mockResolvedValueOnce({
      alive: true, sessionId: 'uuid-warm', sessionStatus: 'started', turn: { status: 'running', since: '2026-09-20T00:00:00.000Z' },
    });
    const { result } = renderHook(harness());
    await act(async () => { await result.current.lifecycle.rebindPersistentSession(); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.lifecycle.turn.status).toBe('running');
    expect(result.current.lifecycle.conversationStatus).toBe('running');
  });
});

describe('useSessionLifecycle — launch permission mode', () => {
  it('remembers the mode the session was started with', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result } = renderHook(harness());
    expect(result.current.lifecycle.launchPermissionMode).toBeNull();
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    expect(result.current.lifecycle.launchPermissionMode).toBe('default');
  });

  it('starts under an overriding mode when given one', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result } = renderHook(harness());
    await act(async () => {
      await result.current.lifecycle.startPersistentSession('uuid-1', { permissionMode: 'bypassPermissions' });
    });
    expect((api.startSession as any).mock.calls[0][3]).toBe('bypassPermissions');
    expect(result.current.lifecycle.launchPermissionMode).toBe('bypassPermissions');
  });

  it('learns the launch mode from sessionGetHealth on rebind', async () => {
    (api.sessionRebind as any).mockResolvedValueOnce(true);
    (api.sessionGetHealth as any).mockResolvedValueOnce({
      alive: true, sessionId: 'uuid-warm', sessionStatus: 'started',
      turn: { status: 'idle', since: null }, launchPermissionMode: 'bypassPermissions',
    });
    const { result } = renderHook(harness());
    await act(async () => { await result.current.lifecycle.rebindPersistentSession(); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.lifecycle.launchPermissionMode).toBe('bypassPermissions');
  });
});

describe('useSessionLifecycle — sessionStatus + conversationStatus', () => {
  it('defaults to sessionStatus=stopped, conversationStatus=null before any activity', () => {
    const { result } = renderHook(harness());
    expect(result.current.lifecycle.sessionStatus).toBe('stopped');
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
    expect(result.current.lifecycle.conversationStatus).toBeNull();

    await act(async () => { resolveStart(); await p!; });
  });

  it('derives conversationStatus="idle" when session is started and messages are empty', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result } = renderHook(harness({ messages: [], tasks: [], subagents: [] }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started' });
    });
    expect(result.current.lifecycle.sessionStatus).toBe('started');
    expect(result.current.lifecycle.conversationStatus).toBe('idle');
  });

  it('reports conversationStatus="running" only when the session says its turn is running', async () => {
    const messages = [makeUserPrompt()];
    const { result } = renderHook(harness({ messages, tasks: [], subagents: [] }));
    (api.startSession as any).mockResolvedValueOnce(undefined);
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    act(() => { eventListeners['session-status:tab-life']({ sessionStatus: 'started' }); });
    expect(result.current.lifecycle.conversationStatus).toBe('idle');
    act(() => { eventListeners['session-turn:tab-life']({ status: 'running', since: '2026-09-20T00:00:00.000Z' }); });
    expect(result.current.lifecycle.conversationStatus).toBe('running');
  });

  it('derives conversationStatus="idle" when last assistant message has a terminal stop_reason', async () => {
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
    expect(result.current.lifecycle.conversationStatus).toBe('running');
  });

  it('conversationStatus is null when sessionStatus is not "started", regardless of messages', async () => {
    const messages = [makeUserPrompt()];
    const { result } = renderHook(harness({ messages }));
    expect(result.current.lifecycle.conversationStatus).toBeNull();
  });

  it('forces conversationStatus to null when sessionStatus leaves "started" (invariant)', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const messages = [makeUserPrompt()];
    const { result } = renderHook(harness({ messages }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started' });
      eventListeners['session-turn:tab-life']({ status: 'running', since: '2026-09-20T00:00:00.000Z' });
    });
    expect(result.current.lifecycle.conversationStatus).toBe('running');

    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'error' });
    });
    expect(result.current.lifecycle.sessionStatus).toBe('error');
    expect(result.current.lifecycle.conversationStatus).toBeNull();
    expect(result.current.lifecycle.turn.status).toBe('idle');
  });

  it('ignores payloads without a sessionStatus field', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result } = renderHook(harness());
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started' });
    });
    expect(result.current.lifecycle.sessionStatus).toBe('started');
    expect(result.current.lifecycle.conversationStatus).toBe('idle');

    act(() => { eventListeners['session-status:tab-life'](undefined); });
    act(() => { eventListeners['session-status:tab-life']({}); });
    expect(result.current.lifecycle.sessionStatus).toBe('started');
    expect(result.current.lifecycle.conversationStatus).toBe('idle');
  });

  it('ignores a conversationStatus field on session-status — the turn arrives on its own channel', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result } = renderHook(harness());
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started', conversationStatus: 'running' });
    });
    expect(result.current.lifecycle.sessionStatus).toBe('started');
    expect(result.current.lifecycle.conversationStatus).toBe('idle');
  });

  it('user message with a parent_tool_use_id is forwarded subagent traffic and does not drive the turn axis', async () => {
    // CLI >= 2.1.211: a non-empty parent_tool_use_id marks forwarded subagent
    // traffic.
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const messages = [
      makeUserPrompt({ parent_tool_use_id: 'toolu_abc123', message: { role: 'user', content: 'hello' } }),
    ];
    const { result } = renderHook(harness({ messages, tasks: [], subagents: [] }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started' });
    });
    expect(result.current.lifecycle.conversationStatus).toBe('idle');
  });

});

describe('useSessionLifecycle — StrictMode-safe', () => {
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

describe('useSessionLifecycle — live permission mode', () => {
  // A transcript whose only prompt was a slash command carries no
  // permissionMode.
  it('adopts the daemon\'s live mode after a start', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    (api.sessionGetHealth as any).mockResolvedValueOnce({
      alive: true, sessionId: 'u1', sessionStatus: 'started', turn: { status: 'idle', since: null },
      launchPermissionMode: 'auto', permissionMode: 'auto',
    });
    const onLivePermissionMode = vi.fn();
    const { result } = renderHook(harness({ onLivePermissionMode }));
    await act(async () => { await result.current.lifecycle.startPersistentSession('u1'); });
    await act(async () => { await Promise.resolve(); });
    expect(onLivePermissionMode).toHaveBeenCalledWith('auto');
    expect(result.current.lifecycle.launchPermissionMode).toBe('auto');
  });

  it('adopts the daemon\'s live mode on rebind', async () => {
    (api.sessionRebind as any).mockResolvedValueOnce(true);
    (api.sessionGetHealth as any).mockResolvedValueOnce({
      alive: true, sessionId: 'u1', sessionStatus: 'started', turn: { status: 'idle', since: null },
      launchPermissionMode: 'default', permissionMode: 'plan',
    });
    const onLivePermissionMode = vi.fn();
    const { result } = renderHook(harness({ onLivePermissionMode }));
    await act(async () => { await result.current.lifecycle.rebindPersistentSession(); });
    await act(async () => { await Promise.resolve(); });
    expect(onLivePermissionMode).toHaveBeenCalledWith('plan');
  });

  it('leaves the picker alone when the daemon does not report a mode', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    (api.sessionGetHealth as any).mockResolvedValueOnce({ alive: false, sessionId: null, sessionStatus: 'stopped' });
    const onLivePermissionMode = vi.fn();
    const { result } = renderHook(harness({ onLivePermissionMode }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    await act(async () => { await Promise.resolve(); });
    expect(onLivePermissionMode).not.toHaveBeenCalled();
  });
});
