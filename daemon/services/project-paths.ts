import fs from 'node:fs';
import path from 'node:path';

/** Lossy: `/a/pi-tuitive` and `/a/pi/tuitive` encode the same. Prefer `recoverProjectPath()`. */
export function decodeProjectId(projectId: string): string {
  const stripped = projectId.replace(/^-+/, '');
  return '/' + stripped.replace(/-/g, '/');
}

/** Newest mtime wins: after a folder rename the CLI keeps writing the same encoded dir with the new cwd. */
export function recoverProjectPath(projectDir: string, projectId: string): string {
  const fallback = decodeProjectId(projectId);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return fallback;
  }
  const files = jsonlNames(entries).map((name) => {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(path.join(projectDir, name)).mtimeMs;
    } catch {
      // Stat failure → treat as oldest so a readable file still wins.
    }
    return { name, mtimeMs };
  });
  for (const { name } of newestFirst(files)) {
    let fd: number;
    try {
      fd = fs.openSync(path.join(projectDir, name), 'r');
    } catch {
      continue;
    }
    try {
      const scan = createHeadScan();
      const buf = Buffer.alloc(HEAD_CHUNK);
      let pos = 0;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, HEAD_CHUNK, pos);
        const done = n === 0;
        pos += n;
        const cwd = scan.push(buf.subarray(0, n), done);
        if (cwd !== undefined) {
          if (cwd) return cwd;
          break;
        }
      }
    } catch {
      // Unreadable — try the next transcript.
    } finally {
      fs.closeSync(fd);
    }
  }
  return fallback;
}

export async function recoverProjectPathAsync(projectDir: string, projectId: string): Promise<string> {
  const fallback = decodeProjectId(projectId);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
  } catch {
    return fallback;
  }
  const files = await Promise.all(jsonlNames(entries).map(async (name) => {
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.promises.stat(path.join(projectDir, name))).mtimeMs;
    } catch {
      // Stat failure → treat as oldest so a readable file still wins.
    }
    return { name, mtimeMs };
  }));
  for (const { name } of newestFirst(files)) {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(path.join(projectDir, name), 'r');
    } catch {
      continue;
    }
    try {
      const scan = createHeadScan();
      const buf = Buffer.alloc(HEAD_CHUNK);
      let pos = 0;
      for (;;) {
        const { bytesRead: n } = await handle.read(buf, 0, HEAD_CHUNK, pos);
        const done = n === 0;
        pos += n;
        const cwd = scan.push(buf.subarray(0, n), done);
        if (cwd !== undefined) {
          if (cwd) return cwd;
          break;
        }
      }
    } catch {
      // Unreadable — try the next transcript.
    } finally {
      await handle.close();
    }
  }
  return fallback;
}

const HEAD_CHUNK = 64 * 1024;
const HEAD_LINES = 50;

function jsonlNames(entries: fs.Dirent[]): string[] {
  return entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name);
}

function newestFirst<T extends { mtimeMs: number }>(files: T[]): T[] {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function createHeadScan(): { push(chunk: Buffer, done: boolean): string | undefined } {
  let pending = Buffer.alloc(0);
  let lines = 0;
  const check = (raw: Buffer): string | undefined => {
    lines += 1;
    const line = raw.toString('utf8').trim();
    if (!line) return undefined;
    try {
      const cwd = (JSON.parse(line) as Record<string, unknown>).cwd;
      if (typeof cwd === 'string' && cwd.startsWith('/')) return cwd;
    } catch {
      // Corrupt line — keep trying.
    }
    return undefined;
  };
  return {
    push(chunk, done) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let nl: number;
      while ((nl = pending.indexOf(0x0a)) !== -1) {
        const cwd = check(pending.subarray(0, nl));
        pending = pending.subarray(nl + 1);
        if (cwd) return cwd;
        if (lines >= HEAD_LINES) return '';
      }
      if (done) return (pending.length ? check(pending) : undefined) ?? '';
      // Copy so the caller can reuse its read buffer.
      pending = Buffer.from(pending);
      return undefined;
    },
  };
}

/** Must match the CLI: past this it truncates and appends a hash. */
const MAX_PROJECT_KEY_LEN = 200;

/** Transcribed from the CLI binary. `|0` keeps every step int32; dropping it diverges on long paths. */
function cliPathHash(normalizedPath: string): string {
  let h = 0;
  for (let i = 0; i < normalizedPath.length; i++) {
    h = ((h << 5) - h + normalizedPath.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/**
 * Must match the CLI: every non-alphanumeric character becomes `-`, not just slashes (resolve() step 3 relies on it).
 * Lossy, so never decode it; read the dir's transcripts instead. Lives here, not claude.ts, to avoid an import cycle with accounts.ts.
 */
export function encodeProjectId(projectPath: string): string {
  const normalized = projectPath.normalize('NFC');
  const key = normalized.replace(/[^a-zA-Z0-9]/g, '-');
  if (key.length <= MAX_PROJECT_KEY_LEN) return key;
  return `${key.slice(0, MAX_PROJECT_KEY_LEN)}-${cliPathHash(normalized)}`;
}
