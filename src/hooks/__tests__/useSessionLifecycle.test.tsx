// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import type { ClaudeStreamMessage } from '@/types/claudeStream';

vi.mock('@/lib/api', () => ({
  api: {
    startSession: vi.fn(),
    stopSession: vi.fn().mockResolvedValue(undefined),
    sessionRebind: vi.fn().mockResolvedValue(false),
    sessionAccountInfo: vi.fn().mockResolvedValue(null),
    resolveAccountForProject: vi.fn().mockResolvedValue(null),
    getSupportedModels: vi.fn().mockResolvedValue([]),
    getSupportedCommands: vi.fn().mockResolvedValue([]),
    getContextUsage: vi.fn().mockResolvedValue(null),
  },
}));

// onEvent / send shims — useSessionLifecycle attaches stream listeners on start
beforeEach(() => {
  (window as any).electronAPI = {
    onEvent: vi.fn(() => () => {}),
    invoke: vi.fn().mockResolvedValue(undefined),
  };
});

import { api } from '@/lib/api';
import { useSessionLifecycle } from '../useSessionLifecycle';

function harness(overrides: { messages?: ClaudeStreamMessage[] } = {}) {
  return () => {
    const persistentSessionRef = useRef(false);
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
        setIsSessionActive: vi.fn(),
        handleStreamMessage: vi.fn(),
        setIsLoading: vi.fn(),
        setMessages: ((updater: any) => {
          messagesRef.current = typeof updater === 'function'
            ? updater(messagesRef.current)
            : updater;
        }) as any,
        setSdkAccountInfo: vi.fn(),
        setSupportedModels: vi.fn(),
        setSupportedCommands: vi.fn(),
        setContextUsage: vi.fn(),
      }),
      messagesRef,
      isStartingRef,
    };
  };
}

describe('useSessionLifecycle — startPersistentSession error surface', () => {
  it('appends a synthetic error message and clears the Starting badge when startSession rejects', async () => {
    (api.startSession as any).mockRejectedValueOnce(
      new Error('No Claude account could be resolved for project'),
    );

    const { result } = renderHook(harness());

    // Sanity: badge starts off, no messages.
    expect(result.current.isStartingRef.current).toBe(false);
    expect(result.current.messagesRef.current).toHaveLength(0);

    // Drive the failure path. .catch keeps the assertion-side of the test
    // from also failing on the rejection.
    await act(async () => {
      await result.current.lifecycle.startPersistentSession().catch(() => {});
    });

    // The badge must have been flipped back off (otherwise the user sees
    // a stuck "Starting…" indicator forever).
    expect(result.current.isStartingRef.current).toBe(false);

    // A renderer-visible system error should have been appended to messages.
    const msgs = result.current.messagesRef.current as any[];
    expect(msgs.length).toBeGreaterThan(0);
    const errMsg = msgs[msgs.length - 1];
    expect(errMsg.type).toBe('system');
    expect(errMsg.subtype).toBe('notification');
    expect(errMsg.notification_type).toBe('error');
    // Message must surface the underlying cause so the user knows what to fix.
    expect(String(errMsg.message)).toMatch(/No Claude account/i);
  });
});
