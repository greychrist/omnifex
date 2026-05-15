// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useDebounce, useDebouncedCallback } from '../useDebounce';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('useDebounce', () => {
  it('returns the initial value synchronously on first render', () => {
    const { result } = renderHook(() => useDebounce('initial', 200));
    expect(result.current).toBe('initial');
  });

  it('delays propagation of new values by the configured delay', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 200),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    // Pre-delay: still the old value.
    expect(result.current).toBe('a');

    act(() => { vi.advanceTimersByTime(199); });
    expect(result.current).toBe('a');

    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe('b');
  });

  it('resets the timer when the value changes again before the delay elapses', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebounce(value, 200),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    act(() => { vi.advanceTimersByTime(150); });
    rerender({ value: 'c' });
    // The second change resets the timer — 150ms in, still showing 'a'.
    act(() => { vi.advanceTimersByTime(150); });
    expect(result.current).toBe('a');

    // Another 50ms (200 total since the 'c' update) and we should see it.
    act(() => { vi.advanceTimersByTime(50); });
    expect(result.current).toBe('c');
  });

  it('clears the pending timer on unmount so no setState fires after teardown', () => {
    const { result, rerender, unmount } = renderHook(
      ({ value }) => useDebounce(value, 200),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    unmount();
    // Advancing past the delay must NOT throw a "setState on unmounted" warning;
    // the cleanup clears the timeout. We can also assert the captured result
    // never updated past 'a' (renderHook freezes after unmount).
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current).toBe('a');
  });
});

describe('useDebouncedCallback', () => {
  it('invokes the callback only after the delay since the last call', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 200));

    result.current('first');
    expect(fn).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(200); });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith('first');
  });

  it('coalesces rapid calls and only fires once with the latest args', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 100));

    result.current('a');
    act(() => { vi.advanceTimersByTime(50); });
    result.current('b');
    act(() => { vi.advanceTimersByTime(50); });
    result.current('c');

    // Still no fire — the third call reset the timer.
    expect(fn).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(100); });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith('c');
  });

  it('reads the latest callback via ref — stale closures over `fn` do not fire', () => {
    let captured = 'first';
    const { result, rerender } = renderHook(
      ({ cb }) => useDebouncedCallback(cb, 100),
      {
        initialProps: {
          cb: () => { captured = 'first'; },
        },
      },
    );

    // Schedule a call with the first callback, then swap it before the timer fires.
    result.current();
    rerender({ cb: () => { captured = 'second'; } });
    act(() => { vi.advanceTimersByTime(100); });
    // The hook reads callbackRef.current at fire time — the swap wins.
    expect(captured).toBe('second');
  });

  it('returns a stable function identity across renders', () => {
    const fn = vi.fn();
    const { result, rerender } = renderHook(
      ({ delay }) => useDebouncedCallback(fn, delay),
      { initialProps: { delay: 100 } },
    );
    const first = result.current;
    rerender({ delay: 200 });
    expect(result.current).toBe(first);
  });
});
