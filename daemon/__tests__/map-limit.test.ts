import { describe, it, expect } from 'vitest';
import { mapLimit } from '../services/util/map-limit';

describe('mapLimit', () => {
  it('maps every item, keeping input order', async () => {
    const out = await mapLimit([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  // libuv's thread pool has four workers; flooding it starves every other fs
  // call.
  it('never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running -= 1;
    });
    expect(peak).toBe(3);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
