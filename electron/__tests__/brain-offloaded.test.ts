import { describe, it, expect, vi } from 'vitest';
import { countOffloadedFiles } from '../services/brain/offloaded';

describe('countOffloadedFiles', () => {
  it('reports how many files a file provider has evicted', async () => {
    const exec = vi.fn().mockResolvedValue('     825\n');

    expect(await countOffloadedFiles('/v', exec, 'darwin')).toBe(825);
    expect(exec).toHaveBeenCalledWith('/v');
  });

  it('reports zero for a fully materialised vault', async () => {
    expect(await countOffloadedFiles('/v', vi.fn().mockResolvedValue('0\n'), 'darwin')).toBe(0);
  });

  it('does not probe off darwin, where the concept does not exist', async () => {
    const exec = vi.fn();

    expect(await countOffloadedFiles('/v', exec, 'linux')).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it('answers unknown rather than zero when the probe fails', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('find: -flags: unknown option'));

    expect(await countOffloadedFiles('/v', exec, 'darwin')).toBeNull();
  });

  it('answers unknown rather than NaN when the output is not a count', async () => {
    expect(await countOffloadedFiles('/v', vi.fn().mockResolvedValue('what\n'), 'darwin')).toBeNull();
  });
});
