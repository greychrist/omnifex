// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import type { ClaudeStreamMessage } from '@/types/claudeStream';

vi.mock('@/lib/api', () => ({
  api: {
    startSession: vi.fn(),
    stopSession: vi.fn().mockResolvedValue(undefined),
    sessionRebind: vi.fn().mockResolvedValue(false),
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
  setIsSessionActive?: ReturnType<typeof vi.fn>;
  setIsLoading?: ReturnType<typeof vi.fn>;
  handleStreamMessage?: ReturnType<typeof vi.fn>;
  setSdkAccountInfo?: ReturnType<typeof vi.fn>;
  setSupportedModels?: ReturnType<typeof vi.fn>;
  setSupportedCommands?: ReturnType<typeof vi.fn>;
  setContextUsage?: ReturnType<typeof vi.fn>;
}

function harness(overrides: HarnessOverrides = {}) {
  return () => {
    const persistentSessionRef = useRef(overrides.initialPersistent ?? false);
    const messagesRef = useRef<ClaudeStreamMessage[]>(overrides.messages ?? []);
    const isStartingRef = useRef<boolean>(false);

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
        setIsSessionStarting: (v: any) => {
          isStartingRef.current = typeof v === 'function' ? v(isStartingRef.current) : v;
        },
        setIsSessionActive: (overrides.setIsSessionActive ?? vi.fn()) as any,
        handleStreamMessage: (overrides.handleStreamMessage ?? vi.fn()) as any,
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
      isStartingRef,
    };
  };
}

describe('useSessionLifecycle — startPersistentSession happy path', () => {
  it('flips Starting badge true, attaches listeners, calls api.startSession with resolved config, and seeds the init message', async () => {
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
    );
    expect(result.current.persistentSessionRef.current).toBe(true);
    // Listeners attached on the four claude-* channels.
    expect(Object.keys(eventListeners).sort()).toEqual([
      'claude-complete:tab-life',
      'claude-error:tab-life',
      'claude-output-extra:tab-life',
      'claude-output:tab-life',
    ]);
    // Synthetic system:init message was inserted at the head.
    const init = result.current.messagesRef.current[0] as any;
    expect(init.type).toBe('system');
    expect(init.subtype).toBe('init');
    expect(init.tools).toContain('Bash');
  });

  it('is a no-op when persistentSessionRef is already true', async () => {
    const { result } = renderHook(harness({ initialPersistent: true }));
    await act(async () => {
      await result.current.lifecycle.startPersistentSession();
    });
    expect(api.startSession).not.toHaveBeenCalled();
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
          setIsSessionStarting: vi.fn(),
          setIsSessionActive: vi.fn(),
          handleStreamMessage: vi.fn(),
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
        setIsSessionStarting: vi.fn(), setIsSessionActive: vi.fn(),
        handleStreamMessage: vi.fn(), setIsLoading: vi.fn(),
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
  it('appends a synthetic error message and clears the Starting badge when startSession rejects', async () => {
    (api.startSession as any).mockRejectedValueOnce(
      new Error('No Claude account could be resolved for project'),
    );
    const setIsLoading = vi.fn();
    const { result } = renderHook(harness({ setIsLoading }));

    expect(result.current.isStartingRef.current).toBe(false);
    expect(result.current.messagesRef.current).toHaveLength(0);

    await act(async () => {
      await result.current.lifecycle.startPersistentSession().catch(() => {});
    });

    expect(result.current.isStartingRef.current).toBe(false);
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

  it('returns true, attaches listeners, sets persistent flag, and flips badges when rebind succeeds', async () => {
    (api.sessionRebind as any).mockResolvedValueOnce(true);
    const setIsSessionActive = vi.fn();
    const { result } = renderHook(harness({ setIsSessionActive }));
    let rebound = false;
    await act(async () => { rebound = await result.current.lifecycle.rebindPersistentSession(); });
    expect(rebound).toBe(true);
    expect(result.current.persistentSessionRef.current).toBe(true);
    expect(setIsSessionActive).toHaveBeenCalledWith(true);
    expect(Object.keys(eventListeners)).toContain('claude-output:tab-life');
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
  it('forwards claude-output payloads to handleStreamMessage', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const handleStreamMessage = vi.fn();
    const { result } = renderHook(harness({ handleStreamMessage }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    act(() => { eventListeners['claude-output:tab-life']('{"type":"user"}'); });
    expect(handleStreamMessage).toHaveBeenCalledWith('{"type":"user"}');
  });

  it('forwards claude-output-extra (closure carrier channel) to handleStreamMessage too', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const handleStreamMessage = vi.fn();
    const { result } = renderHook(harness({ handleStreamMessage }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });

    const payload = { type: 'system', subtype: 'task_notification' };
    act(() => { eventListeners['claude-output-extra:tab-life'](payload); });
    expect(handleStreamMessage).toHaveBeenCalledWith(payload);
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

  it('claude-complete clears loading + persistent flag and flips both badges off', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const setIsLoading = vi.fn();
    const setIsSessionActive = vi.fn();
    const { result } = renderHook(harness({ setIsLoading, setIsSessionActive }));
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    expect(result.current.persistentSessionRef.current).toBe(true);

    act(() => { eventListeners['claude-complete:tab-life'](undefined); });
    expect(setIsLoading).toHaveBeenCalledWith(false);
    expect(result.current.persistentSessionRef.current).toBe(false);
    expect(setIsSessionActive).toHaveBeenLastCalledWith(false);
  });
});

describe('useSessionLifecycle — unmount cleanup', () => {
  it('calls api.stopSession on unmount when a session was running', async () => {
    (api.startSession as any).mockResolvedValueOnce(undefined);
    const { result, unmount } = renderHook(harness());
    await act(async () => { await result.current.lifecycle.startPersistentSession(); });
    expect(result.current.persistentSessionRef.current).toBe(true);

    unmount();
    expect(api.stopSession).toHaveBeenCalledWith('tab-life');
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

      const { result } = renderHook(harness());
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

  it('writes account info, supported models/commands, context usage and re-upserts init with MCP tools', async () => {
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

    const { result } = renderHook(harness({
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
});
