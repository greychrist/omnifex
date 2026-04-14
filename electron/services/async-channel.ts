export interface AsyncChannel<T> {
  push(value: T): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

export function createAsyncChannel<T>(maxSize?: number): AsyncChannel<T> {
  const queue: T[] = [];
  let resolve: ((result: IteratorResult<T>) => void) | null = null;
  let closed = false;

  return {
    push(value: T) {
      if (closed) return;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value, done: false });
      } else {
        if (maxSize !== undefined && queue.length >= maxSize) {
          console.warn(
            `[AsyncChannel] Queue reached maxSize=${maxSize}; dropping oldest item.`,
          );
          queue.shift();
        }
        queue.push(value);
      }
    },

    close() {
      closed = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined as any, done: true });
      }
    },

    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as any, done: true });
          }
          return new Promise<IteratorResult<T>>((r) => {
            resolve = r;
          });
        },
      };
    },
  };
}
