import os from 'node:os';

/**
 * Spell a literal path so a gitignore-style glob matcher reads it as itself.
 *
 * `*`, `?` and `[` are glob syntax; a real filesystem path containing one
 * means the character, not the pattern. Escaping is bracket-quoting — the
 * CLI's own idiom, which it tells users about directly (2.1.260: "spell a
 * literal parenthesis as `[(]` or `[)]`").
 *
 * Two failure modes this closes:
 *   • `~/Downloads/report[1.pdf` compiled to nothing — an unclosed `[` made
 *     the whole rule an invalid pattern, and one such rule failed EVERY file
 *     edit in the session with "Invalid regular expression". CLI 2.1.260
 *     stopped that cascade, but only for users on 2.1.260 or later.
 *   • `~/Repos/[archive]/x.ts` compiled to a character class, so the rule
 *     matched nothing and the user re-prompted forever with no error at all.
 *     The CLI still reads a balanced `[...]` that way; only escaping fixes it.
 *
 * Parentheses are deliberately NOT escaped: rule content runs to the final
 * `)`, and everything before it is literal, so `Edit(~/Brain (backup)/n.md)`
 * is already correct. Bracketing them would make the rule wrong.
 */
function escapeGlobLiterals(p: string): string {
  return p.replace(/[*?[]/g, (c) => `[${c}]`);
}

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
 *   • home-relative or already-relative inputs keep their prefix
 *
 * Whatever form it takes, the result is a *literal* path being handed to a
 * glob matcher, so `escapeGlobLiterals` spells out its metacharacters. See
 * that function for why.
 */
export function formatFilePathForRule(
  filePath: string,
  projectPath: string,
  homeDir: string = os.homedir(),
): string {
  if (filePath.startsWith('~/') || filePath === '~') return escapeGlobLiterals(filePath);
  if (!filePath.startsWith('/')) return escapeGlobLiterals(filePath); // already relative

  const project = projectPath.replace(/\/+$/, '');
  if (filePath === project) return '/';
  if (project && filePath.startsWith(project + '/')) {
    return escapeGlobLiterals(filePath.slice(project.length)); // begins with "/"
  }

  const home = (homeDir || '').replace(/\/+$/, '');
  if (home) {
    if (filePath === home) return '~';
    if (filePath.startsWith(home + '/')) {
      return `~${escapeGlobLiterals(filePath.slice(home.length))}`; // "~/..."
    }
  }

  // Absolute filesystem path outside both project and home — needs the
  // double-slash form so the matcher doesn't treat it as project-relative.
  return `/${escapeGlobLiterals(filePath)}`;
}
