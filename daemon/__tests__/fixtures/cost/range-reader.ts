export function rangeReader(
  get: (p: string) => string | null,
): (p: string, start: number, end: number) => Promise<Buffer | null> {
  return async (p, start, end) => {
    const content = get(p);
    return content === null ? null : Buffer.from(content).subarray(start, end);
  };
}
