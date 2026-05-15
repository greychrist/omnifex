// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useApiCall } from '../useApiCall';

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // The hook logs via console.log / console.error for the toast TODO —
  // suppress so test output stays clean while still letting us assert
  // call counts.
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  cleanup();
});

describe('useApiCall — happy path', () => {
  it('starts with null data, no loading, no error', () => {
    const { result } = renderHook(() => useApiCall(async () => 'x'));
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('returns the resolved value and stores it in data', async () => {
    const fn = vi.fn(async () => 42);
    const { result } = renderHook(() => useApiCall<number>(fn));
    let returned: number | null = null;
    await act(async () => { returned = await result.current.call(); });
    expect(returned).toBe(42);
    expect(result.current.data).toBe(42);
    expect(result.current.isLoading).toBe(false);
  });

  it('calls onSuccess with the resolved value', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useApiCall(async () => 'ok', { onSuccess }));
    await act(async () => { await result.current.call(); });
    expect(onSuccess).toHaveBeenCalledWith('ok');
  });

  it('logs a success message when showSuccessToast=true', async () => {
    const { result } = renderHook(() =>
      useApiCall(async () => 'ok', {
        showSuccessToast: true,
        successMessage: 'custom success',
      }),
    );
    await act(async () => { await result.current.call(); });
    expect(consoleLogSpy).toHaveBeenCalledWith('Success:', 'custom success');
  });

  it('forwards arguments to the wrapped function', async () => {
    const fn = vi.fn(async (a: number, b: number) => a * b);
    const { result } = renderHook(() => useApiCall<number>(fn));
    await act(async () => { await result.current.call(3, 4); });
    expect(fn).toHaveBeenCalledWith(3, 4);
    expect(result.current.data).toBe(12);
  });
});

describe('useApiCall — error path', () => {
  it('captures the Error, calls onError, and returns null (does NOT throw)', async () => {
    const boom = new Error('boom');
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useApiCall<string>(async () => { throw boom; }, { onError }),
    );

    let returned: string | null = 'sentinel';
    await act(async () => { returned = await result.current.call(); });

    expect(returned).toBeNull();
    expect(result.current.error).toBe(boom);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('logs via console.error when showErrorToast=true (default)', async () => {
    const boom = new Error('details');
    const { result } = renderHook(() =>
      useApiCall(async () => { throw boom; }),
    );
    await act(async () => { await result.current.call(); });
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error:', 'details');
  });

  it('uses errorMessage when provided', async () => {
    const { result } = renderHook(() =>
      useApiCall(async () => { throw new Error('raw'); }, { errorMessage: 'pretty' }),
    );
    await act(async () => { await result.current.call(); });
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error:', 'pretty');
  });

  it('coerces non-Error throws into Error("An error occurred")', async () => {
    const { result } = renderHook(() =>
      useApiCall<string>(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional: exercising the non-Error throw branch.
        throw 'oops';
      }),
    );
    await act(async () => { await result.current.call(); });
    expect(result.current.error?.message).toBe('An error occurred');
  });

  it('AbortError rejections are silently ignored — no error captured', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useApiCall<string>(async () => { throw abortErr; }, { onError }),
    );
    let returned: string | null = 'sentinel';
    await act(async () => { returned = await result.current.call(); });
    expect(returned).toBeNull();
    expect(result.current.error).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('useApiCall — lifecycle', () => {
  it('reset() clears data, error, and isLoading', async () => {
    const { result } = renderHook(() => useApiCall(async () => 'x'));
    await act(async () => { await result.current.call(); });
    expect(result.current.data).toBe('x');

    act(() => { result.current.reset(); });
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('does not setState after unmount', async () => {
    let resolveIt: (v: string) => void = () => {};
    const fn = vi.fn(() => new Promise<string>((resolve) => { resolveIt = resolve; }));
    const { result, unmount } = renderHook(() => useApiCall<string>(fn));

    let exec: Promise<string | null>;
    act(() => { exec = result.current.call(); });
    unmount();
    // Resolving after unmount: hook should silently no-op (the previous
    // call returned `null` for unmounted callers). If the hook tried to
    // setState we'd see an unmounted-component warning in jsdom.
    await act(async () => {
      resolveIt('late');
      await exec;
    });
  });
});
