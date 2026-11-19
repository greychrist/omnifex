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
    const { result } = renderHook(() => useSessionViewMode(), { wrapper: wrapperFor({ config: withDefault('expanded'), loaded: true }) });
    expect(result.current[0]).toBe('expanded');
  });

  it('opens in standard before settings load, then takes the saved default', () => {
    const state = { config: createDefaultConfig(), loaded: false };
    const { result, rerender } = renderHook(() => useSessionViewMode(), { wrapper: ({ children }) => wrapperFor(state)({ children }) });
    expect(result.current[0]).toBe('standard');
    state.config = withDefault('expanded');
    state.loaded = true;
    rerender();
    expect(result.current[0]).toBe('expanded');
  });

  // With two views, a later default can only differ from the pick by being
  // the one picked before load; the pick still wins.
  it('keeps a view picked before the settings finish loading', () => {
    const state = { config: createDefaultConfig(), loaded: false };
    const { result, rerender } = renderHook(() => useSessionViewMode(), { wrapper: ({ children }) => wrapperFor(state)({ children }) });
    act(() => { result.current[1]('expanded'); });
    state.config = withDefault('standard');
    state.loaded = true;
    rerender();
    expect(result.current[0]).toBe('expanded');
  });

  it('does not move an open session when the default changes', () => {
    const state = { config: withDefault('standard'), loaded: true };
    const { result, rerender } = renderHook(() => useSessionViewMode(), { wrapper: ({ children }) => wrapperFor(state)({ children }) });
    state.config = withDefault('expanded');
    rerender();
    expect(result.current[0]).toBe('standard');
  });
});
