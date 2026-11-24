/** Never rejects: the Markdown is already written, so a git failure must not fail the caller. */
export function fireAndLogGitFailure(p: Promise<unknown>, label: string): void {
  void p.catch((err: unknown) => {
    console.warn(`${label} failed:`, err);
  });
}
