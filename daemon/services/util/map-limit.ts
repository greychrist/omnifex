/**
 * `Promise.all(items.map(fn))` with at most `limit` calls in flight. For fs
 * fan-out: async fs runs on libuv's small thread pool (four workers by
 * default), and hundreds of queued reads would starve every other fs call the
 * daemon makes in the meantime. Results keep input order.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
