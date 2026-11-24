export function logAndForget(label: string, p: Promise<unknown>): void {
  p.catch((err: unknown) => {
    console.error(`[${label}]`, err);
  });
}

export function fireAndLog<TArgs extends unknown[]>(
  label: string,
  fn: ((...args: TArgs) => Promise<unknown> | void) | undefined,
): (...args: TArgs) => void {
  return (...args: TArgs) => {
    if (!fn) return;
    const result = fn(...args);
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        console.error(`[${label}]`, err);
      });
    }
  };
}
