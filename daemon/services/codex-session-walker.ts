// Never throws: a missing sessions dir is [], and a malformed rollout is skipped.

import fs from 'node:fs';
import path from 'node:path';
import type { Account } from './accounts';
import { mapLimit } from './util/map-limit';

export interface CodexSessionEntry {
  conversationId: string;
  projectPath: string | null;
  lastActivity: string;
  jsonlPath: string;
  accountId: number;
}

export interface CodexSessionWalker {
  listSessions(): Promise<CodexSessionEntry[]>;
}

export interface CreateCodexSessionWalkerDeps {
  listCodexAccounts: () => Account[];
}

async function collectJsonlFiles(rootDir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const ent of entries) {
    const full = path.join(rootDir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await collectJsonlFiles(full)));
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

const HEAD_CHUNK = 64 * 1024;
/** A first line past this isn't usable, and reading on would read the whole file. */
const MAX_FIRST_LINE = 4 * 1024 * 1024;
const FS_CONCURRENCY = 8;

async function readFirstLine(filePath: string): Promise<string | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(HEAD_CHUNK);
      const { bytesRead } = await handle.read(buf, 0, HEAD_CHUNK, total);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      const nl = chunk.indexOf(0x0a);
      if (nl !== -1) {
        chunks.push(chunk.subarray(0, nl));
        break;
      }
      chunks.push(chunk);
      total += bytesRead;
      if (total >= MAX_FIRST_LINE) return null;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

const PROJECT_PATH_KEYS = ['cwd', 'project_path', 'working_directory'] as const;

const FILENAME_UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const FILENAME_UUID_BARE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function conversationIdFromFilename(filePath: string): string {
  const base = path.basename(filePath);
  const tail = FILENAME_UUID_TAIL.exec(base);
  if (tail) return tail[1].toLowerCase();
  const bare = FILENAME_UUID_BARE.exec(base);
  if (bare) return bare[1].toLowerCase();
  return base.replace(/\.jsonl$/i, '');
}

async function readFirstRecordMeta(
  filePath: string,
): Promise<{ conversationId: string | null; projectPath: string | null }> {
  const firstLine = (await readFirstLine(filePath))?.trim();
  if (!firstLine) return { conversationId: null, projectPath: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return { conversationId: null, projectPath: null };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { conversationId: null, projectPath: null };
  }

  const rec = parsed as Record<string, unknown>;
  const payload =
    rec.payload && typeof rec.payload === 'object'
      ? (rec.payload as Record<string, unknown>)
      : rec;

  const idRaw = payload.id;
  const conversationId =
    typeof idRaw === 'string' && idRaw.length > 0 ? idRaw : null;

  let projectPath: string | null = null;
  for (const key of PROJECT_PATH_KEYS) {
    const v = payload[key];
    if (typeof v === 'string' && v.length > 0) {
      projectPath = v;
      break;
    }
  }

  return { conversationId, projectPath };
}

async function scanCodexSessionsDir(sessionsDir: string): Promise<Omit<CodexSessionEntry, 'accountId'>[]> {
  const files = await collectJsonlFiles(sessionsDir);
  const entries = await mapLimit(files, FS_CONCURRENCY, async (file) => {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return null;
    }

    const fromFile = await readFirstRecordMeta(file);
    const conversationId =
      fromFile.conversationId ?? conversationIdFromFilename(file);

    return {
      conversationId,
      projectPath: fromFile.projectPath,
      lastActivity: stat.mtime.toISOString(),
      jsonlPath: file,
    };
  });

  return entries.filter((e): e is Omit<CodexSessionEntry, 'accountId'> => e !== null);
}

export function createCodexSessionWalker(
  deps: CreateCodexSessionWalkerDeps,
): CodexSessionWalker {
  return {
    async listSessions(): Promise<CodexSessionEntry[]> {
      const all: CodexSessionEntry[] = [];
      for (const acct of deps.listCodexAccounts()) {
        const sessionsDir = path.join(acct.config_dir, 'sessions');
        for (const entry of await scanCodexSessionsDir(sessionsDir)) {
          all.push({ ...entry, accountId: acct.id });
        }
      }

      all.sort(
        (a, b) =>
          new Date(b.lastActivity).getTime() -
          new Date(a.lastActivity).getTime(),
      );

      return all;
    },
  };
}
