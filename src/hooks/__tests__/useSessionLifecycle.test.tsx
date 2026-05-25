// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React, { useRef, StrictMode } from 'react';
import type { ClaudeStreamMessage } from '@/types/claudeStream';

vi.mock('@/lib/api', () => ({
  api: {
    startSession: vi.fn(),
    stopSession: vi.fn().mockResolvedValue(undefined),
    sessionRebind: vi.fn().mockResolvedValue(false),
    sessionGetHealth: vi.fn().mockResolvedValue({ alive: false, sessionId: null, sessionStatus: 'stopped', conversationStatus: null }),
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
  initialPersistent?: boolean;
  setIsLoading?: ReturnType<typeof vi.fn>;
  handleJsonlLine?: ReturnType<typeof vi.fn>;
  setSdkAccountInfo?: ReturnType<typeof vi.fn>;
  setSupportedModels?: ReturnType<typeof vi.fn>;
  setSupportedCommands?: ReturnType<typeof vi.fn>;
  setContextUsage?: ReturnType<typeof vi.fn>;
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
        setSdkAccountInfo: (overrides.setSdkAccountInfo ?? vi.fn()) as any,
        setSupportedModels: (overrides.setSupportedModels ?? vi.fn()) as any,
        setSupportedCommands: (overrides.setSupportedCommands ?? vi.fn()) as any,
        setContextUsage: (overrides.setContextUsage ?? vi.fn()) as any,
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
    );
    expect(result.current.persistentSessionRef.current).toBe(true);
    // Listeners attached on the four claude-* channels plus session-status.
    expect(Object.keys(eventListeners).sort()).toEqual([
      'claude-complete:tab-life',
      'claude-error:tab-life',
      'claude-output-extra:tab-life',
      'claude-output:tab-life',
      'session-status:tab-life',
    ]);
    // No placeholder init is rendered — the chat stays empty until the
    // SDK iterator yields its real system:init via claude-output.
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
    (api.resolveAccountForProject as any).mockResolvedValueOnce({
      config_dir: '/fallback-cfg',
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
          setSdkAccountInfo: vi.fn(),
          setSupportedModels: vi.fn(),
          setSupportedCommands: vi.fn(),
          setContextUsage: vi.fn(),
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
        setSdkAccountInfo: vi.fn(), setSupportedModels: vi.fn(),
        setSupportedCommands: vi.fn(), setContextUsage: vi.fn(),
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

  it('returns true, attaches listeners, sets persistent flag, and seeds both axes from sessionGetHealth when rebind succeeds', async () => {
    (api.sessionRebind as any).mockResolvedValueOnce(true);
    (api.sessionGetHealth as any).mockResolvedValueOnce({
      alive: true, sessionId: 'uuid-warm', sessionStatus: 'started', conversationStatus: 'idle',
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
    expect(Object.keys(eventListeners)).toContain('claude-output:tab-life');
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
  it('forwards claude-output payloads to handleJsonlLine (JSONL pipeline enabled by default)', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const handleJsonlLine = vi.fn();
    const { result } = renderHook(harness({ handleJsonlLine }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    act(() => { eventListeners['claude-output:tab-life']('{"type":"user"}'); });
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

    act(() => { eventListeners['claude-error:tab-life']('no stdin data received in 5s'); });
    act(() => { eventListeners['claude-error:tab-life']('proceeding without it'); });
    expect(errorSpy).not.toHaveBeenCalled();

    // Genuinely unexpected stderr DOES log.
    act(() => { eventListeners['claude-error:tab-life']('SIGSEGV'); });
    expect(errorSpy).toHaveBeenCalledWith('[ClaudeCodeSession] stderr:', 'SIGSEGV');
    errorSpy.mockRestore();
  });

  it('claude-complete clears loading + persistent flag; status is owned by main-process session-status event', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const setIsLoading = vi.fn();
    const { result } = renderHook(harness({ setIsLoading }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    expect(result.current.persistentSessionRef.current).toBe(true);

    act(() => { eventListeners['claude-complete:tab-life'](undefined); });
    expect(setIsLoading).toHaveBeenCalledWith(false);
    expect(result.current.persistentSessionRef.current).toBe(false);

    // Main process emits the 'stopped' transition on the session-status
    // channel; the hook reflects it. Payload carries both axes.
    act(() => { eventListeners['session-status:tab-life']({ sessionStatus: 'stopped', conversationStatus: null }); });
    expect(result.current.lifecycle.sessionStatus).toBe('stopped');
    expect(result.current.lifecycle.conversationStatus).toBeNull();
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

describe('useSessionLifecycle — fetchInitInfo enrichment', () => {
  it('keeps polling mcpServerStatus while any server is pending, then stops once every server is terminal', async () => {
    // Under SDK 0.3.x MCP servers connect in the background; slow servers
    // surface as `status: 'pending'` in the first init response. We must
    // re-poll until every server reaches a terminal state — connected,
    // failed, needs-auth, or disabled — so the renderer's tool list isn't
    // permanently missing tools from a still-warming server.
    vi.useFakeTimers();
    try {
      (api.startSession as any).mockResolvedValueOnce(undefined);
      (api.sessionAccountInfo as any).mockResolvedValue({
        name: 'work', account_type: 'pro', config_dir: '/cfg',
      });
      (api.sessionSupportedModels as any).mockResolvedValue([]);
      (api.sessionSupportedCommands as any).mockResolvedValue([]);
      (api.sessionContextUsage as any).mockResolvedValue(null);
      // First poll: foo connected with one tool, bar still warming up.
      // Second poll: both servers connected.
      (api.sessionMcpServerStatus as any)
        .mockResolvedValueOnce([
          { name: 'foo', status: 'connected', tools: [{ name: 'a' }] },
          { name: 'bar', status: 'pending' },
        ])
        .mockResolvedValueOnce([
          { name: 'foo', status: 'connected', tools: [{ name: 'a' }] },
          { name: 'bar', status: 'connected', tools: [{ name: 'b' }] },
        ]);

      // Seed a real init message — without it, enrichInitTools is a no-op
      // by design (it only merges into the SDK's actual init, never inserts).
      const seededInit = [{ type: 'system', subtype: 'init', session_id: 'real-id', model: 'sonnet', cwd: '/r', tools: [] } as any];
      const { result } = renderHook(harness({ messages: seededInit }));
      await act(async () => { await result.current.lifecycle.startPersistentSession(); });
      // Flush the first poll's microtasks.
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      let init = result.current.messagesRef.current[0] as any;
      expect(init.tools).toContain('mcp__foo__a');
      expect(init.tools).not.toContain('mcp__bar__b');
      expect(api.sessionMcpServerStatus).toHaveBeenCalledTimes(1);

      // Advance past the 1500ms re-poll wait. After the second poll the
      // pending server has flipped to connected and its tool is merged in.
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

      init = result.current.messagesRef.current[0] as any;
      expect(init.tools).toContain('mcp__foo__a');
      expect(init.tools).toContain('mcp__bar__b');
      expect(api.sessionMcpServerStatus).toHaveBeenCalledTimes(2);

      // Now every server is terminal — no third poll should ever fire.
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(api.sessionMcpServerStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling when every server is in a non-pending terminal state (failed / needs-auth / disabled)', async () => {
    vi.useFakeTimers();
    try {
      (api.startSession as any).mockResolvedValueOnce(undefined);
      (api.sessionAccountInfo as any).mockResolvedValue({
        name: 'work', account_type: 'pro', config_dir: '/cfg',
      });
      (api.sessionSupportedModels as any).mockResolvedValue([]);
      (api.sessionSupportedCommands as any).mockResolvedValue([]);
      (api.sessionContextUsage as any).mockResolvedValue(null);
      (api.sessionMcpServerStatus as any).mockResolvedValueOnce([
        { name: 'a', status: 'failed' },
        { name: 'b', status: 'needs-auth' },
        { name: 'c', status: 'disabled' },
      ]);

      const { result } = renderHook(harness());
      await act(async () => { await result.current.lifecycle.startPersistentSession(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(api.sessionMcpServerStatus).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(api.sessionMcpServerStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes account info, supported models/commands, context usage and enriches the real init with MCP tools', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    (api.sessionAccountInfo as any).mockResolvedValue({
      name: 'work',
      account_type: 'pro',
      config_dir: '/cfg',
    });
    (api.sessionSupportedModels as any).mockResolvedValueOnce([
      { id: 'sonnet', label: 'Sonnet' },
    ]);
    (api.sessionSupportedCommands as any).mockResolvedValueOnce([{ name: '/help' }]);
    (api.sessionMcpServerStatus as any).mockResolvedValueOnce([
      { name: 'foo!server', status: 'connected', tools: [{ name: 'do_x' }] },
    ]);
    (api.sessionContextUsage as any).mockResolvedValueOnce({ used: 100, total: 1000 });

    const setSdkAccountInfo = vi.fn();
    const setSupportedModels = vi.fn();
    const setSupportedCommands = vi.fn();
    const setContextUsage = vi.fn();

    // Seed a real init so enrichInitTools has something to merge into.
    const seededInit = [{ type: 'system', subtype: 'init', session_id: 'real-id', model: 'sonnet', cwd: '/r', tools: [] } as any];
    const { result } = renderHook(harness({
      messages: seededInit,
      setSdkAccountInfo, setSupportedModels, setSupportedCommands, setContextUsage,
    }));

    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    // fetchInitInfo is fired via logAndForget; flush its microtasks/promise chain.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(setSdkAccountInfo).toHaveBeenCalledWith({ name: 'work', account_type: 'pro', config_dir: '/cfg' });
    expect(setSupportedModels).toHaveBeenCalled();
    expect(setSupportedCommands).toHaveBeenCalled();
    expect(setContextUsage).toHaveBeenCalled();

    // After enrichment, the init message should now contain the MCP-derived
    // tool name (mangled per the standard mcp__<server>__<tool> convention).
    const init = result.current.messagesRef.current[0] as any;
    expect(init.tools).toContain('mcp__foo_server__do_x');
  });

  it('flips sessionStatus to started from control-channel readiness, without inserting a synthetic init', async () => {
    // After sessionAccountInfo() answers, fetchInitInfo treats the control
    // channel as live and pushes sessionStatus → started so the badge reaches
    // 'Active' without waiting for the first prompt. claudeSessionId stays
    // null — SDK 0.3.150 doesn't surface a session_id pre-prompt; the real
    // GUID arrives later via the streamed system:init through claude-output.
    (api.startSession as any).mockResolvedValueOnce(undefined);
    (api.sessionAccountInfo as any).mockResolvedValue({
      name: 'work', account_type: 'pro', config_dir: '/cfg',
    });
    (api.sessionMcpServerStatus as any).mockResolvedValueOnce([
      { name: 'mcp1', status: 'connected', tools: [{ name: 't' }] },
    ]);
    const handleJsonlLine = vi.fn();
    const { result } = renderHook(harness({ handleJsonlLine }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(result.current.lifecycle.sessionStatus).toBe('started');
    expect(result.current.lifecycle.conversationStatus).toBe('idle');
    // No synthetic system:init was injected from the renderer side. The
    // sessionGetHealth poll path was removed once we accepted that the SDK
    // can't surface a session_id before the first prompt.
    expect(handleJsonlLine).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'system', subtype: 'init' }),
    );
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

  it('reflects sessionStatus=started + conversationStatus transitions from main-process events', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result } = renderHook(harness());
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    // system:init → started + idle
    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started', conversationStatus: 'idle' });
    });
    expect(result.current.lifecycle.sessionStatus).toBe('started');
    expect(result.current.lifecycle.conversationStatus).toBe('idle');

    // turn → running
    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started', conversationStatus: 'running' });
    });
    expect(result.current.lifecycle.conversationStatus).toBe('running');

    // canUseTool → waiting_permission
    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started', conversationStatus: 'waiting_permission' });
    });
    expect(result.current.lifecycle.conversationStatus).toBe('waiting_permission');
  });

  it('forces conversationStatus to null when sessionStatus leaves "started" (invariant)', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result } = renderHook(harness());
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started', conversationStatus: 'running' });
    });
    expect(result.current.lifecycle.conversationStatus).toBe('running');

    // Even if main accidentally sent a conversationStatus alongside a
    // non-started sessionStatus, the hook clears it per the invariant.
    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'error', conversationStatus: 'running' });
    });
    expect(result.current.lifecycle.sessionStatus).toBe('error');
    expect(result.current.lifecycle.conversationStatus).toBeNull();
  });

  it('ignores payloads without a sessionStatus field', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result } = renderHook(harness());
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    act(() => {
      eventListeners['session-status:tab-life']({ sessionStatus: 'started', conversationStatus: 'idle' });
    });
    expect(result.current.lifecycle.sessionStatus).toBe('started');

    act(() => { eventListeners['session-status:tab-life'](undefined); });
    act(() => { eventListeners['session-status:tab-life']({}); });
    expect(result.current.lifecycle.sessionStatus).toBe('started');
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
