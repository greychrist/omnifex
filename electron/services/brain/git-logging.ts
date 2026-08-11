/**
 * Swallow and log a background git operation. Versioning is auxiliary: a
 * missing git binary or a locked index must never reject into a caller that
 * has already written the Markdown successfully.
 */
export function fireAndLogGitFailure(p: Promise<unknown>, label: string): void {
  void p.catch((err: unknown) => {
    console.warn(`${label} failed:`, err);
  });
}
