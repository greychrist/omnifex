import { describe, it, expect, vi } from 'vitest';
import { createLoginExpiryService } from '../services/login-expiry';

const HOUR = 60 * 60 * 1000;

function setup(answers: Array<string | null | Error>) {
  let t = Date.parse('2026-11-04T12:00:00.000Z');
  const probe = vi.fn(async (_configDir: string) => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { loginExpiresAt: next ?? null };
  });
  const svc = createLoginExpiryService({ probe, now: () => t });
  return { svc, probe, advance: (ms: number) => { t += ms; } };
}

describe('createLoginExpiryService', () => {
  it('returns the CLI-reported expiry with when it was checked', async () => {
    const { svc } = setup(['2026-11-27T11:18:46.996Z']);
    expect(await svc.get('/c')).toEqual({
      expiresAt: '2026-11-27T11:18:46.996Z',
      checkedAt: '2026-11-04T12:00:00.000Z',
    });
  });

  it('serves from cache inside the TTL and probes again after it', async () => {
    const { svc, probe, advance } = setup(['2026-11-27T00:00:00.000Z', '2026-12-01T00:00:00.000Z']);
    await svc.get('/c');
    advance(5 * HOUR);
    expect((await svc.get('/c'))?.expiresAt).toBe('2026-11-27T00:00:00.000Z');
    expect(probe).toHaveBeenCalledTimes(1);
    advance(2 * HOUR);
    expect((await svc.get('/c'))?.expiresAt).toBe('2026-12-01T00:00:00.000Z');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent reads of one config dir into one spawn', async () => {
    const { svc, probe } = setup(['2026-11-27T00:00:00.000Z']);
    const [a, b] = await Promise.all([svc.get('/c'), svc.get('/c')]);
    expect(a).toEqual(b);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps config dirs apart', async () => {
    const { svc } = setup(['2026-11-27T00:00:00.000Z', '2026-11-20T00:00:00.000Z']);
    expect((await svc.get('/personal'))?.expiresAt).toBe('2026-11-27T00:00:00.000Z');
    expect((await svc.get('/work'))?.expiresAt).toBe('2026-11-20T00:00:00.000Z');
  });

  it('refresh and invalidate bypass the cache (a sign-in moves the date)', async () => {
    const { svc, probe } = setup(['2026-11-27T00:00:00.000Z', '2026-12-04T00:00:00.000Z', '2026-12-05T00:00:00.000Z']);
    await svc.get('/c');
    expect((await svc.get('/c', { refresh: true }))?.expiresAt).toBe('2026-12-04T00:00:00.000Z');
    svc.invalidate('/c');
    expect((await svc.get('/c'))?.expiresAt).toBe('2026-12-05T00:00:00.000Z');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('reports null expiry (no stored sign-in end) as a real answer', async () => {
    const { svc } = setup([null]);
    expect((await svc.get('/c'))?.expiresAt).toBeNull();
  });

  // A failed spawn is not evidence the sign-in has no end, so it is not
  // cached and answers null (unknown), not `{ expiresAt: null }`.
  it('answers null and caches nothing when the probe fails', async () => {
    const { svc, probe } = setup([new Error('spawn failed'), '2026-11-27T00:00:00.000Z']);
    expect(await svc.get('/c')).toBeNull();
    expect((await svc.get('/c'))?.expiresAt).toBe('2026-11-27T00:00:00.000Z');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('refuses an empty config dir rather than probing the default', async () => {
    const { svc, probe } = setup([]);
    expect(await svc.get('')).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});
