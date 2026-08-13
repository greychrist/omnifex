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
