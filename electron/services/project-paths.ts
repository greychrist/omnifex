import fs from 'node:fs';
import path from 'node:path';

/**
 * Turning a Claude Code project directory back into the folder it stands for.
 *
 * Lives on its own because two unrelated subsystems need the same answer:
 * `claude.ts` (the project list) and the Brain's source adapters (the Sources
 * pane). Two copies would drift, and the whole point of `recoverProjectPath`
 * is that it is the ONE correct way to do something the obvious way gets
 * wrong.
 */

/**
 * The naive inverse of Claude Code's project-id encoding: strip the leading
 * dash, then swap every remaining dash for a slash.
 *
 * The encoding is **lossy** — `/Users/g/pi-tuitive-fe` and
 * `/Users/g/pi/tuitive/fe` both encode to `-Users-g-pi-tuitive-fe`. Use
 * `recoverProjectPath()` whenever the project dir is available; this naive
 * form is the fallback for when no JSONL exists yet.
 */
export function decodeProjectId(projectId: string): string {
  // Result always starts with "/" so it's an absolute path.
  const stripped = projectId.replace(/^-+/, '');
  return '/' + stripped.replace(/-/g, '/');
}

/**
 * Recover the true project path by reading the authoritative `cwd` from
 * the most recently written JSONL entry that carries one. Falls back to
 * the naive decode when no JSONL exists, no entry has `cwd`, or the
 * files are unreadable.
 *
 * The authoritative source: Claude Code writes `cwd` onto user / assistant
 * / tool-use entries in the session JSONL. Any of them is fine — the
 * field reflects where the session was rooted at the time the entry was
 * written, which is what the project dir represents.
 *
 * Why mtime-desc, not alphabetical: when a project folder is renamed
 * (e.g. greychrist → omnifex), Claude continues writing to the SAME
 * encoded project-id dir but with the new cwd. Older JSONLs in that dir
 * still carry the pre-rename cwd. JSONL filenames are random UUIDs, so
 * alphabetical order is effectively random and may surface a stale cwd
 * indefinitely after a rename. Newest mtime always wins, so a single new
 * session under the new name is enough to flip the displayed path.
 *
 * Cost: stat each JSONL (cheap — already directory-cached), then one
 * short `readFileSync` of the newest JSONL plus a per-line JSON.parse
 * until `cwd` is found. We scan at most ~50 lines per project; for the
 * typical Recent-Projects list of ~20 entries this stays well under
 * 50ms of cold-cache IO.
 */
export function recoverProjectPath(projectDir: string, projectId: string): string {
  const fallback = decodeProjectId(projectId);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return fallback;
  }

  const jsonlFiles: { name: string; mtimeMs: number }[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(path.join(projectDir, e.name)).mtimeMs;
    } catch {
      // Stat failure → treat as oldest so a readable file still wins.
    }
    jsonlFiles.push({ name: e.name, mtimeMs });
  }
  // Newest first — see the rename rationale above.
  jsonlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { name } of jsonlFiles) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(projectDir, name), 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    // Cap to keep cold-cache cost bounded on very long sessions; `cwd`
    // appears on essentially every user/assistant entry so the first
    // handful suffices in practice.
    const cap = Math.min(lines.length, 50);
    for (let i = 0; i < cap; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const cwd = obj.cwd;
        if (typeof cwd === 'string' && cwd.startsWith('/')) {
          return cwd;
        }
      } catch {
        // Corrupt line — keep trying.
      }
    }
  }

  return fallback;
}

/**
 * Longest sanitized key the CLI writes verbatim. Past this it truncates and
 * appends a hash of the full path, so two deep paths sharing a 200-char
 * prefix can't collide on one directory.
 */
const MAX_PROJECT_KEY_LEN = 200;

/**
 * The CLI's path hash: djb2-style 32-bit rolling hash of the *normalized*
 * path (not the sanitized key), rendered base-36. Transcribed from the
 * 2.1.224 binary — `(t<<5)-t+charCodeAt(i)|0`, then `Math.abs(...).toString(36)`.
 *
 * `|0` keeps every step in int32, which is what makes the result reproducible;
 * dropping it would silently diverge once a path is long enough to overflow.
 */
function cliPathHash(normalizedPath: string): string {
  let h = 0;
  for (let i = 0; i < normalizedPath.length; i++) {
    h = ((h << 5) - h + normalizedPath.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/**
 * Encode a project path the way the Claude CLI names its project directories:
 * NFC-normalize the absolute path, replace every non-alphanumeric character
 * with `-`, and — past `MAX_PROJECT_KEY_LEN` — truncate and append a hash of
 * the normalized path.
 *
 *   /Users/foo/bar        → -Users-foo-bar
 *   /Users/foo/my_app.v2  → -Users-foo-my-app-v2
 *
 * The rule is "every non-alphanumeric", not "every slash". This used to be
 * slash-only here while `sessions/summary-query.ts` carried a second, correct
 * copy — so lookups that went through this one silently missed any path
 * containing a dot, underscore or space. `accounts.resolve()` step 3 read that
 * miss as "no on-disk evidence" for projects that were sitting right there:
 * `.../pi-tuitive/.claude-worktrees/PI-390` lives in
 * `-Users-…-pi-tuitive--claude-worktrees-PI-390`, which the slash-only form
 * never produced. The two copies are now one; see the CLI 2.1.224 directory
 * capture pinned in `sessions-summary-query.test.ts`.
 *
 * Still lossy, and `decodeProjectId` is still only its naive inverse — a
 * folder whose own name contains a dash encodes identically to a nested path,
 * which is why `recoverProjectPath` reads directory contents rather than
 * decoding, and why on-disk ownership treats a miss as "no evidence" rather
 * than a guess.
 *
 * Lives here rather than in `claude.ts` so `accounts.ts` can share it:
 * `claude.ts` already imports `accounts.ts`, so the reverse would be a cycle.
 */
export function encodeProjectId(projectPath: string): string {
  const normalized = projectPath.normalize('NFC');
  const key = normalized.replace(/[^a-zA-Z0-9]/g, '-');
  if (key.length <= MAX_PROJECT_KEY_LEN) return key;
  return `${key.slice(0, MAX_PROJECT_KEY_LEN)}-${cliPathHash(normalized)}`;
}
