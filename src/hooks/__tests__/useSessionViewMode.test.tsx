// @vitest-environment jsdom
//
// A session opens in the chat format chosen in Appearance › All cards.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { createDefaultConfig, type MessageRenderingConfig } from '@/lib/messageRenderingConfig';
import { MessageRenderingContext } from '@/contexts/MessageRenderingContext';
import { useSessionViewMode } from '../useSessionViewMode';

afterEach(cleanup);

function wrapperFor(state: { config: MessageRenderingConfig; loaded: boolean }) {
  return ({ children }: { children: React.ReactNode }) => (
    <MessageRenderingContext.Provider value={{ config: state.config, loaded: state.loaded, setConfig: async () => {} }}>
      {children}
    </MessageRenderingContext.Provider>
  );
}

const withDefault = (mode: MessageRenderingConfig['defaultViewMode']) => ({ ...createDefaultConfig(), defaultViewMode: mode });

describe('useSessionViewMode', () => {
  it('opens in the saved default chat format', () => {
    const { result } = renderHook(() => useSessionViewMode(), { wrapper: wrapperFor({ config: withDefault('modern'), loaded: true }) });
    expect(result.current[0]).toBe('modern');
  });

  it('takes the saved default once the settings finish loading', () => {
    const state = { config: createDefaultConfig(), loaded: false };
    const { result, rerender } = renderHook(() => useSessionViewMode(), { wrapper: ({ children }) => wrapperFor(state)({ children }) });
    expect(result.current[0]).toBe('compact');
    state.config = withDefault('modern');
    state.loaded = true;
    rerender();
    expect(result.current[0]).toBe('modern');
  });

  it('keeps a format picked in the session when the default changes later', () => {
    const state = { config: withDefault('verbose'), loaded: true };
    const { result, rerender } = renderHook(() => useSessionViewMode(), { wrapper: ({ children }) => wrapperFor(state)({ children }) });
    act(() => { result.current[1]('all'); });
    state.config = withDefault('modern');
    rerender();
    expect(result.current[0]).toBe('all');
  });

  it('does not move an open session when the default changes', () => {
    const state = { config: withDefault('verbose'), loaded: true };
    const { result, rerender } = renderHook(() => useSessionViewMode(), { wrapper: ({ children }) => wrapperFor(state)({ children }) });
    state.config = withDefault('modern');
    rerender();
    expect(result.current[0]).toBe('verbose');
  });
});
