/**
 * Bracket-quote glob metacharacters, the CLI's own idiom. An unclosed `[` invalidates the rule (pre-2.1.260 it failed
 * every edit); a balanced `[...]` is a character class. Parentheses are NOT escaped: rule content runs to the final `)`.
 */
function escapeGlobLiterals(p: string): string {
  return p.replace(/[*?[]/g, (c) => `[${c}]`);
}

/** A single leading `/` is project-root-relative; an absolute path outside project and home needs `//`. */
export function formatFilePathForRule(
  filePath: string,
  projectPath: string,
  homeDir: string,
): string {
  if (filePath.startsWith('~/') || filePath === '~') return escapeGlobLiterals(filePath);
  if (!filePath.startsWith('/')) return escapeGlobLiterals(filePath);

  const project = projectPath.replace(/\/+$/, '');
  if (filePath === project) return '/';
  if (project && filePath.startsWith(project + '/')) {
    return escapeGlobLiterals(filePath.slice(project.length));
  }

  const home = (homeDir || '').replace(/\/+$/, '');
  if (home) {
    if (filePath === home) return '~';
    if (filePath.startsWith(home + '/')) {
      return `~${escapeGlobLiterals(filePath.slice(home.length))}`;
    }
  }

  return `/${escapeGlobLiterals(filePath)}`;
}
