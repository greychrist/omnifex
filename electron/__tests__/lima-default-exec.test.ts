import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Lima tab polls limactl every few seconds. Spawned by bare name it cost
// 6 throwaway processes per call (one per PATH miss) and 18 syspolicyd lines
// per tick, so the default runner must go through the resolving helper.

const execFileOnPath = vi.hoisted(() => vi.fn());
vi.mock('../services/util/spawn', () => ({ execFileOnPath }));

import { createLimaService } from '../services/lima';

beforeEach(() => { execFileOnPath.mockReset(); });

describe('lima default limactl runner', () => {
  it('resolves limactl through execFileOnPath', async () => {
    execFileOnPath.mockImplementation((_n: string, _a: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) => {
      cb(null, 'limactl version 1.0.0\n', '');
    });
    expect(await createLimaService().isInstalled()).toBe(true);
    expect(execFileOnPath).toHaveBeenCalledWith('limactl', ['--version'], expect.any(Object), expect.any(Function));
  });

  it('still reads an ENOENT from the helper as "not installed"', async () => {
    execFileOnPath.mockImplementation((_n: string, _a: string[], _o: unknown, cb: (e: NodeJS.ErrnoException) => void) => {
      cb(Object.assign(new Error('spawn limactl ENOENT'), { code: 'ENOENT' }));
    });
    expect(await createLimaService().isInstalled()).toBe(false);
  });
});
