import os from 'node:os';

/**
 * Format a filesystem path into a Claude Code permission-rule pattern.
 *
 * Claude Code's `permissions.allow` syntax uses gitignore-style path forms:
 *
 *   //absolute/path    — absolute filesystem path (DOUBLE slash)
 *   ~/home/path        — home-relative
 *   /project/relative  — project-root-relative (SINGLE slash = anchored)
 *   path or ./path     — current-directory-relative
 *
 * A single leading "/" on an absolute-looking path is interpreted as
 * "project-root-relative", not "absolute" — so a naive rule like
 * `Edit(/Users/alice/proj/src/foo.ts)` is silently ineffective: the matcher
 * looks for `<project-root>/Users/alice/proj/src/foo.ts` and finds nothing.
 *
 * This helper returns the most readable pattern for a given `filePath`:
 *   • inside `projectPath`  → project-relative "/rel/path"   (portable across worktrees of the repo)
 *   • inside the home dir   → home-relative   "~/rel/path"   (survives username / machine changes)
 *   • elsewhere             → absolute        "//abs/path"   (mandatory double slash)
 *   • home-relative or already-relative inputs pass through unchanged
 */
export function formatFilePathForRule(
  filePath: string,
  projectPath: string,
  homeDir: string = os.homedir(),
): string {
  if (filePath.startsWith('~/') || filePath === '~') return filePath;
  if (!filePath.startsWith('/')) return filePath; // already relative

  const project = projectPath.replace(/\/+$/, '');
  if (filePath === project) return '/';
  if (project && filePath.startsWith(project + '/')) {
    return filePath.slice(project.length); // begins with "/"
  }

  const home = (homeDir || '').replace(/\/+$/, '');
  if (home) {
    if (filePath === home) return '~';
    if (filePath.startsWith(home + '/')) {
      return `~${filePath.slice(home.length)}`; // "~/..."
    }
  }

  // Absolute filesystem path outside both project and home — needs the
  // double-slash form so the matcher doesn't treat it as project-relative.
  return `/${filePath}`;
}
