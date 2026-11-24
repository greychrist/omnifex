import { describe, it, expect, vi, beforeEach } from 'vitest';

// A bare `limactl` spawns once per PATH miss.

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
