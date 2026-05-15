// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useLoadingState } from '../useLoadingState';

afterEach(() => { cleanup(); });

describe('useLoadingState', () => {
  it('exposes the initial state: no data, not loading, no error', () => {
    const { result } = renderHook(() => useLoadingState(async () => 'hi'));
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('flips isLoading true during execute and back to false after success', async () => {
    let resolveIt: (v: string) => void = () => {};
    const fn = vi.fn(() => new Promise<string>((resolve) => { resolveIt = resolve; }));
    const { result } = renderHook(() => useLoadingState<string>(fn));

    let exec: Promise<string>;
    act(() => { exec = result.current.execute(); });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();

    await act(async () => {
      resolveIt('done');
      await exec;
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBe('done');
    expect(result.current.error).toBeNull();
  });

  it('captures Error objects on rejection, re-throws to the caller, and clears isLoading', async () => {
    const boom = new Error('boom');
    const fn = vi.fn(async () => { throw boom; });
    const { result } = renderHook(() => useLoadingState<string>(fn));

    await act(async () => {
      await expect(result.current.execute()).rejects.toBe(boom);
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBe(boom);
    expect(result.current.data).toBeNull();
  });

  it('coerces non-Error rejections into Error("An error occurred")', async () => {
    const fn = vi.fn(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional: exercising the non-Error rejection branch.
      throw 'string-error';
    });
    const { result } = renderHook(() => useLoadingState<string>(fn));

    await act(async () => {
      await expect(result.current.execute()).rejects.toThrow('An error occurred');
    });
    expect(result.current.error?.message).toBe('An error occurred');
  });

  it('reset() clears data, error, and isLoading', async () => {
    const fn = vi.fn(async () => 'x');
    const { result } = renderHook(() => useLoadingState<string>(fn));
    await act(async () => { await result.current.execute(); });
    expect(result.current.data).toBe('x');

    act(() => { result.current.reset(); });
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('forwards arguments to the wrapped async function', async () => {
    const fn = vi.fn(async (a: number, b: number) => a + b);
    const { result } = renderHook(() => useLoadingState<number>(fn));
    let value = 0;
    await act(async () => { value = await result.current.execute(2, 3); });
    expect(value).toBe(5);
    expect(fn).toHaveBeenCalledWith(2, 3);
  });
});
