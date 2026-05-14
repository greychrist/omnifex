import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireAndLog } from '../fireAndLog';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fireAndLog', () => {
  it('returns a sync void-returning function suitable for JSX handlers / setTimeout / addEventListener', () => {
    const wrapped = fireAndLog('test', async () => 'ok');
    const result = wrapped();
    // The whole point: the wrapped form returns void, not Promise<unknown>.
    // (TypeScript already enforces this via the signature; the runtime
    // assertion documents the contract.)
    expect(result).toBeUndefined();
  });

  it('forwards arguments to the wrapped async function', async () => {
    const fn = vi.fn(async (a: number, b: number) => a + b);
    const wrapped = fireAndLog('add', fn);
    wrapped(2, 3);
    // microtask drain
    await new Promise((r) => setTimeout(r, 0));
    expect(fn).toHaveBeenCalledWith(2, 3);
  });

  it('catches async rejection and console.errors with the label prefix', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wrapped = fireAndLog('boom', async () => {
      throw new Error('explode');
    });
    wrapped();
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).toHaveBeenCalledOnce();
    const [prefix, err] = errSpy.mock.calls[0];
    expect(prefix).toBe('[boom]');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('explode');
  });

  it('does not call console.error when the async function resolves', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wrapped = fireAndLog('ok', async () => 'fine');
    wrapped();
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('handles non-Error rejections (string, undefined, object)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    /* eslint-disable @typescript-eslint/only-throw-error -- intentionally exercising non-Error rejections to verify the helper handles them. */
    fireAndLog('s', async () => { throw 'string-rejection'; })();
    fireAndLog('u', async () => { throw undefined; })();
    fireAndLog('o', async () => { throw { code: 42 }; })();
    /* eslint-enable @typescript-eslint/only-throw-error */
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).toHaveBeenCalledTimes(3);
  });
});
