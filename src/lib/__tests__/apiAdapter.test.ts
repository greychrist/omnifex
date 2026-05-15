// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiCall } from '../apiAdapter';

beforeEach(() => {
  (globalThis as any).window.electronAPI = { invoke: vi.fn() };
});

describe('apiAdapter.apiCall — happy path', () => {
  it('passes the channel + params to window.electronAPI.invoke and returns the resolved value', async () => {
    (window.electronAPI.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const result = await apiCall<{ ok: boolean }>('get_x', { id: 42 });
    expect(result).toEqual({ ok: true });
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('get_x', { id: 42 });
  });

  it('omits params when none are provided (passes undefined)', async () => {
    (window.electronAPI.invoke as ReturnType<typeof vi.fn>).mockResolvedValue('v');
    await apiCall<string>('no_args');
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('no_args', undefined);
  });
});

describe('apiAdapter.apiCall — error decoding', () => {
  it('strips a "[CODE] " prefix off error.message and re-attaches it as error.code', async () => {
    const wireErr = new Error('[NO_ACCOUNT_FOR_PROJECT] /repos/foo has no account binding');
    (window.electronAPI.invoke as ReturnType<typeof vi.fn>).mockRejectedValue(wireErr);

    let caught: unknown;
    try {
      await apiCall('resolve_for_project', { projectPath: '/repos/foo' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('/repos/foo has no account binding');
    expect((caught as Error & { code: string }).code).toBe('NO_ACCOUNT_FOR_PROJECT');
  });

  it("strips Electron's outer wrapper as well as the [CODE] prefix", async () => {
    const wireErr = new Error(
      "Error invoking remote method 'resolve_for_project': [NO_ACCOUNT_FOR_PROJECT] /repos/foo",
    );
    (window.electronAPI.invoke as ReturnType<typeof vi.fn>).mockRejectedValue(wireErr);

    let caught: Error & { code?: string } = new Error();
    try {
      await apiCall('resolve_for_project', {});
    } catch (e) {
      caught = e as Error & { code?: string };
    }
    expect(caught.code).toBe('NO_ACCOUNT_FOR_PROJECT');
    expect(caught.message).toBe('/repos/foo');
  });

  it('returns the original Error unchanged when no [CODE] prefix is present', async () => {
    const wireErr = new Error('plain message — no code');
    (window.electronAPI.invoke as ReturnType<typeof vi.fn>).mockRejectedValue(wireErr);

    let caught: Error & { code?: string } = new Error();
    try {
      await apiCall('plain', {});
    } catch (e) {
      caught = e as Error & { code?: string };
    }
    expect(caught).toBe(wireErr);
    expect(caught.code).toBeUndefined();
  });

  it('lets non-Error rejection values pass through untouched', async () => {
    (window.electronAPI.invoke as ReturnType<typeof vi.fn>).mockRejectedValue('a string');
    let caught: unknown;
    try {
      await apiCall('x');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe('a string');
  });

  it('preserves the original Error name and stack when re-wrapping', async () => {
    const wireErr = new Error('[X_FAIL] body');
    wireErr.name = 'CustomErrorName';
    (window.electronAPI.invoke as ReturnType<typeof vi.fn>).mockRejectedValue(wireErr);

    let caught: Error & { code?: string } = new Error();
    try {
      await apiCall('x');
    } catch (e) {
      caught = e as Error & { code?: string };
    }
    expect(caught.name).toBe('CustomErrorName');
    expect(caught.stack).toBe(wireErr.stack);
  });
});
