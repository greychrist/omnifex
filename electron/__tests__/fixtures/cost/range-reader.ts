/** `CostFs.readRange` over an in-memory `path -> contents` lookup, for test
 *  doubles. Calls `get` once per read, so a test can count reads through it. */
export function rangeReader(
  get: (p: string) => string | null,
): (p: string, start: number, end: number) => Promise<Buffer | null> {
  return async (p, start, end) => {
    const content = get(p);
    return content === null ? null : Buffer.from(content).subarray(start, end);
  };
}
