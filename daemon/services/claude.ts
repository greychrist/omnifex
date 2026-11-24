import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from './database';
import type { AccountsService } from './accounts';
import { createProjectPinsService } from './project-pins';
import { encodeProjectId, recoverProjectPath, recoverProjectPathAsync } from './project-paths';
import { buildClaudeEnv } from './util/claude-env';
import { isRequestReplayLine } from './util/request-replay';
import { createSessionMetadataCache, createSqliteSessionMetadataStore, type SessionMetadata } from './session-metadata-cache';
import { mapLimit } from './util/map-limit';
import { execFileText, probeBinaryVersion } from './util/exec-text';
import { findOnPath } from './util/path-lookup';
import { isSummaryScratchProject } from './sessions/internal-spend';

/** No silent fallback to a default account or `~/.claude`. `code` survives IPC structured-clone; subclass identity does not. */
export class NoAccountError extends Error {
  readonly code = 'NO_ACCOUNT_FOR_PROJECT';
  readonly projectPath: string | undefined;
  readonly projectId: string | undefined;
  constructor(message: string, projectPath?: string, projectId?: string) {
    super(message);
    this.name = 'NoAccountError';
    this.projectPath = projectPath;
    this.projectId = projectId;
  }
}

function noAccountMessage(projectId: string, projectPath?: string): string {
  if (projectPath) {
    return (
      `No Claude account is configured for project path "${projectPath}". ` +
      `Add a path rule or an explicit account override in Account Settings.`
    );
  }
  return (
    `No Claude account could be resolved for project "${projectId}" because ` +
    `no project path was supplied. The renderer must always pass projectPath ` +
    `so account resolution can run — there is no default-account fallback.`
  );
}

export interface Project {
  id: string;
  path: string;
  sessions: string[];
  created_at: number;
  most_recent_session?: number;
  account_id?: number;
  account_name?: string;
  pinned: boolean;
}

export interface Session {
  id: string;
  project_id: string;
  project_path: string;
  todo_data?: unknown;
  created_at: number;
  ai_title?: string;
  /** Outranks `ai_title`; resolve the two with `pickSessionTitle`. */
  custom_title?: string;
  first_timestamp?: string;
  last_timestamp?: string;
  /** @deprecated retained for renderer migration; use last_timestamp instead. */
  message_timestamp?: string;
  file_size_bytes?: number;
}

export interface ClaudeVersionStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
}

export interface ClaudeSettingsOpts {
  /** No `~/.claude` default: the getters/setters throw on an empty configDir. */
  configDir?: string;
}

export interface ClaudeService {
  getHomeDirectory(): string;
  getDefaultModel(opts?: { configDir?: string }): {
    model: string | null;
    source: 'ANTHROPIC_MODEL' | 'ANTHROPIC_DEFAULT_MODEL' | 'settings' | 'none';
  };

  listProjects(): Promise<Project[]>;
  setProjectPinned(args: { projectPath: string; pinned: boolean }): void;
  createProject(projectPath: string): Project;
  getProjectSessions(projectId: string, projectPath?: string): Promise<Session[]>;
  warmSessionMetadata(): Promise<{ files: number }>;

  loadSessionHistory(
    sessionId: string,
    projectId: string,
    projectPath?: string,
  ): Promise<unknown[]>;
  loadAgentSessionHistory(sessionId: string): Promise<unknown[]>;

  deleteSession(
    sessionId: string,
    projectId: string,
    projectPath?: string,
  ): Promise<void>;

  deleteProject(args: {
    accountId: number;
    projectId: string;
  }): Promise<{ deletedPath: string }>;

  getClaudeSettings(opts?: ClaudeSettingsOpts): Promise<Record<string, unknown>>;
  saveClaudeSettings(
    settings: Record<string, unknown>,
    opts?: ClaudeSettingsOpts,
  ): Promise<void>;

  getSystemPrompt(opts?: ClaudeSettingsOpts): Promise<string>;
  saveSystemPrompt(content: string, opts?: ClaudeSettingsOpts): Promise<void>;

  checkClaudeVersion(): Promise<ClaudeVersionStatus>;

  readClaudeMdFile(filePath: string): Promise<string>;
  saveClaudeMdFile(filePath: string, content: string): Promise<void>;

  getHooksConfig(
    scope: 'user' | 'project',
    opts?: ClaudeSettingsOpts & { projectPath?: string },
  ): Promise<Record<string, unknown>>;
  updateHooksConfig(
    scope: 'user' | 'project',
    hooks: Record<string, unknown>,
    opts?: ClaudeSettingsOpts & { projectPath?: string },
  ): Promise<void>;
  validateHookCommand(command: string): { valid: boolean; message: string };
  getMergedHooksConfig(projectPath: string, opts?: ClaudeSettingsOpts): Promise<Record<string, unknown>>;

  getCliUsage(configDir?: string): Promise<string>;
}

/** Streamed in chunks: transcripts reach tens of MB, on the event loop that serves every live session. */
async function readJsonlFile(filePath: string): Promise<unknown[]> {
  const results: unknown[] = [];
  const take = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || isRequestReplayLine(trimmed)) return;
    try {
      results.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines — never throw
    }
  };
  try {
    // utf8 stream encoding keeps a character split across chunks intact.
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 256 * 1024 });
    let partial: string[] = [];
    for await (const chunk of stream as AsyncIterable<string>) {
      let start = 0;
      let nl: number;
      while ((nl = chunk.indexOf('\n', start)) !== -1) {
        partial.push(chunk.slice(start, nl));
        take(partial.join(''));
        partial = [];
        start = nl + 1;
      }
      if (start < chunk.length) partial.push(chunk.slice(start));
    }
    if (partial.length) take(partial.join(''));
    return results;
  } catch {
    return [];
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/** No synthetic `~/.claude` entry; only registered accounts. */
function getConfigDirs(accounts: AccountsService): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();

  for (const account of accounts.listAccounts()) {
    if (!seen.has(account.config_dir)) {
      seen.add(account.config_dir);
      dirs.push(account.config_dir);
    }
  }

  return dirs;
}

/** Strictly via `accounts.resolve()`: a stray `projects/<id>/` under the wrong account must not change ownership. */
function findProjectConfigDir(
  accounts: AccountsService,
  projectPath: string | undefined,
): string | null {
  if (!projectPath) return null;
  // Don't catch: resolve() returns null for "no account", so a throw is a real failure and must not become NO_ACCOUNT_FOR_PROJECT.
  const resolved = accounts.resolve(projectPath);
  return resolved.claude?.account.config_dir ?? null;
}

/** Several encoded dirs can recover to one folder; anything meaning "the whole project" must union them. */
async function findProjectDirsForPath(projectsDir: string, projectPath: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const recovered = await Promise.all(
    dirs.map((name) => recoverProjectPathAsync(path.join(projectsDir, name), name)),
  );
  return dirs.filter((_, i) => recovered[i] === projectPath);
}

/** Activity, not mtime: the CLI rewrites a transcript on reopen, so a file whose size is unchanged keeps its earlier activity time. */
const sessionActivity = new Map<string, { size: number; activityMs: number }>();

function activityTimeFor(filePath: string, stat: fs.Stats): number {
  const seen = sessionActivity.get(filePath);
  if (seen?.size === stat.size) {
    return Math.min(seen.activityMs, stat.mtimeMs) === seen.activityMs
      ? seen.activityMs
      : stat.mtimeMs;
  }
  sessionActivity.set(filePath, { size: stat.size, activityMs: stat.mtimeMs });
  return stat.mtimeMs;
}

function claudeOnPath(): string | null {
  return findOnPath(process.platform === 'win32' ? 'claude.exe' : 'claude', process.env.PATH);
}

export function createClaudeService(db: Database, accounts: AccountsService): ClaudeService {
  const pins = createProjectPinsService(db);
  const sessionMetadata = createSessionMetadataCache(createSqliteSessionMetadataStore(db));

  /** Must mirror the CLI's precedence: ANTHROPIC_MODEL > ANTHROPIC_DEFAULT_MODEL > settings.json `model` (every spawn inherits process.env). */
  function getDefaultModel(opts?: { configDir?: string }): {
    model: string | null;
    source: 'ANTHROPIC_MODEL' | 'ANTHROPIC_DEFAULT_MODEL' | 'settings' | 'none';
  } {
    const fromEnv = (key: 'ANTHROPIC_MODEL' | 'ANTHROPIC_DEFAULT_MODEL'): string | null => {
      const v = process.env[key];
      return typeof v === 'string' && v.trim() ? v.trim() : null;
    };
    const envModel = fromEnv('ANTHROPIC_MODEL');
    if (envModel) return { model: envModel, source: 'ANTHROPIC_MODEL' };
    const envDefault = fromEnv('ANTHROPIC_DEFAULT_MODEL');
    if (envDefault) return { model: envDefault, source: 'ANTHROPIC_DEFAULT_MODEL' };
    try {
      if (opts?.configDir) {
        const raw = fs.readFileSync(path.join(opts.configDir, 'settings.json'), 'utf-8');
        const parsed = JSON.parse(raw) as { model?: unknown } | null;
        const m = parsed?.model;
        if (typeof m === 'string' && m.trim()) return { model: m.trim(), source: 'settings' };
      }
    } catch {
      // No pin: the CLI falls through to the tier default too.
    }
    return { model: null, source: 'none' };
  }

  function getHomeDirectory(): string {
    return os.homedir();
  }

  function createProject(projectPath: string): Project {
    const projectId = encodeProjectId(projectPath);

    const resolved = accounts.resolve(projectPath);
    const account = resolved.claude?.account ?? null;
    if (!account) {
      throw new Error(`No account resolved for project ${projectPath}. Configure an account or path rule first.`);
    }
    const configDir = account.config_dir;

    const projectDir = path.join(configDir, 'projects', projectId);
    fs.mkdirSync(projectDir, { recursive: true });

    return {
      id: projectId,
      path: projectPath,
      sessions: [],
      created_at: Math.floor(Date.now() / 1000),
      account_id: account?.id,
      account_name: account?.name,
      pinned: false,
    };
  }

  async function listProjects(): Promise<Project[]> {
    // Keyed by recovered path, not encoded dir: several dirs can resolve to one folder.
    const byPath = new Map<string, Project>();
    const seenIds = new Set<string>();

    const pinnedPaths = new Set(pins.list());

    const accountList = accounts.listAccounts();

    for (const account of accountList) {
      const projectsDir = path.join(account.config_dir, 'projects');
      if (!fs.existsSync(projectsDir)) continue;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projectId = entry.name;
        if (isSummaryScratchProject(projectId)) continue;
        if (seenIds.has(projectId)) continue;
        seenIds.add(projectId);

        const projectDir = path.join(projectsDir, projectId);
        const sessions: string[] = [];
        let mostRecent: number | undefined;
        let createdAt = Date.now();

        let sessionEntries: fs.Dirent[];
        try {
          sessionEntries = fs.readdirSync(projectDir, { withFileTypes: true });
        } catch {
          sessionEntries = [];
        }

        for (const se of sessionEntries) {
          if (!se.isFile() || !se.name.endsWith('.jsonl')) continue;
          sessions.push(se.name.replace(/\.jsonl$/, ''));

          try {
            const sessionPath = path.join(projectDir, se.name);
            const stat = fs.statSync(sessionPath);
            const activity = activityTimeFor(sessionPath, stat);
            if (mostRecent === undefined || activity > mostRecent) {
              mostRecent = activity;
            }
            if (stat.birthtimeMs < createdAt) {
              createdAt = stat.birthtimeMs;
            }
          } catch {
            // ignore stat errors
          }
        }

        const projectPath = recoverProjectPath(projectDir, projectId);
        const recentSec =
          mostRecent !== undefined ? Math.floor(mostRecent / 1000) : undefined;
        const createdSec = Math.floor(createdAt / 1000);

        const existing = byPath.get(projectPath);
        if (!existing) {
          byPath.set(projectPath, {
            id: projectId,
            path: projectPath,
            sessions,
            created_at: createdSec,
            most_recent_session: recentSec,
            account_id: account.id,
            account_name: account.name,
            pinned: pinnedPaths.has(projectPath),
          });
          continue;
        }

        existing.sessions = [...new Set([...existing.sessions, ...sessions])];
        existing.created_at = Math.min(existing.created_at, createdSec);
        if ((recentSec ?? 0) > (existing.most_recent_session ?? 0)) {
          existing.id = projectId;
          existing.account_id = account.id;
          existing.account_name = account.name;
          existing.most_recent_session = recentSec;
        }
      }
    }

    const projects = [...byPath.values()];

    projects.sort((a, b) => {
      const aTime = a.most_recent_session ?? 0;
      const bTime = b.most_recent_session ?? 0;
      return bTime - aTime;
    });

    return projects;
  }

  function setProjectPinned(args: { projectPath: string; pinned: boolean }): void {
    pins.setPinned(args.projectPath, args.pinned);
  }

  async function warmSessionMetadata(): Promise<{ files: number }> {
    let files = 0;
    for (const account of accounts.listAccounts()) {
      const projectsDir = path.join(account.config_dir, 'projects');
      let projects: fs.Dirent[];
      try {
        projects = await fs.promises.readdir(projectsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const project of projects) {
        if (!project.isDirectory() || isSummaryScratchProject(project.name)) continue;
        const projectDir = path.join(projectsDir, project.name);
        let names: string[];
        try {
          names = (await fs.promises.readdir(projectDir, { withFileTypes: true }))
            .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
            .map((e) => e.name);
        } catch {
          continue;
        }
        await mapLimit(names, 2, async (name) => {
          const filePath = path.join(projectDir, name);
          try {
            await sessionMetadata.get(filePath, await fs.promises.stat(filePath));
            files += 1;
          } catch {
            // Gone or unreadable — the sessions page will retry on its own.
          }
        });
      }
    }
    return { files };
  }

  async function getProjectSessions(
    projectId: string,
    projectPath?: string,
  ): Promise<Session[]> {
    const configDir = findProjectConfigDir(accounts, projectPath);
    if (!configDir) {
      throw new NoAccountError(
        noAccountMessage(projectId, projectPath),
        projectPath,
        projectId,
      );
    }

    const projectsDir = path.join(configDir, 'projects');
    // Read every encoded dir: listProjects merges them into one row.
    const resolvedPath =
      projectPath ?? (await recoverProjectPathAsync(path.join(projectsDir, projectId), projectId));
    const dirNames = await findProjectDirsForPath(projectsDir, resolvedPath);
    const projectDirs = dirNames.length > 0 ? dirNames : [projectId];

    const sessions: Session[] = [];

    for (const dirName of projectDirs) {
      const projectDir = path.join(projectsDir, dirName);
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }

      const files = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name);
      // Off the event loop: a cold project is hundreds of MB.
      const rows = await mapLimit(files, 8, async (name): Promise<Session> => {
        const filePath = path.join(projectDir, name);
        let createdAt = Date.now();
        let mtimeFallback: string | undefined;
        let fileSize: number | undefined;
        let metadata: SessionMetadata = {};
        try {
          const stat = await fs.promises.stat(filePath);
          createdAt = stat.birthtimeMs;
          mtimeFallback = new Date(stat.mtimeMs).toISOString();
          fileSize = stat.size;
          metadata = await sessionMetadata.get(filePath, stat);
        } catch {
          // ignore
        }
        const { aiTitle, customTitle, firstTimestamp, lastTimestamp } = metadata;
        return {
          id: name.replace(/\.jsonl$/, ''),
          // The primary id even for secondary dirs; loadSessionHistory searches the siblings.
          project_id: projectId,
          project_path: resolvedPath,
          created_at: Math.floor(createdAt / 1000),
          ai_title: aiTitle,
          custom_title: customTitle,
          first_timestamp: firstTimestamp,
          last_timestamp: lastTimestamp ?? mtimeFallback,
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- still part of the Session wire shape the renderer receives.
          message_timestamp: lastTimestamp ?? mtimeFallback,
          file_size_bytes: fileSize,
        };
      });
      sessions.push(...rows);
      sessionMetadata.prune(projectDir, new Set(files.map((name) => path.join(projectDir, name))));
    }

    // Dedupe: the CLI can write one session into several contributing dirs.
    const byId = new Map<string, Session>();
    for (const session of sessions) {
      const existing = byId.get(session.id);
      if (!existing) {
        byId.set(session.id, session);
        continue;
      }

      const existingTs = existing.last_timestamp;
      const candidateTs = session.last_timestamp;
      const existingTime = existingTs ? Date.parse(existingTs) : NaN;
      const candidateTime = candidateTs ? Date.parse(candidateTs) : NaN;

      let candidateIsNewer: boolean;
      if (!Number.isNaN(candidateTime) && !Number.isNaN(existingTime)) {
        candidateIsNewer = candidateTime > existingTime;
      } else if (!Number.isNaN(candidateTime) !== !Number.isNaN(existingTime)) {
        candidateIsNewer = !Number.isNaN(candidateTime);
      } else if ((session.file_size_bytes ?? 0) !== (existing.file_size_bytes ?? 0)) {
        candidateIsNewer = (session.file_size_bytes ?? 0) > (existing.file_size_bytes ?? 0);
      } else {
        candidateIsNewer = session.created_at > existing.created_at;
      }

      if (candidateIsNewer) byId.set(session.id, session);
    }
    const deduped = [...byId.values()];

    const lastActivityMs = (s: Session): number => {
      const ts = s.last_timestamp;
      const parsed = ts ? Date.parse(ts) : NaN;
      return Number.isNaN(parsed) ? s.created_at * 1000 : parsed;
    };
    deduped.sort((a, b) => lastActivityMs(b) - lastActivityMs(a));
    return deduped;
  }

  async function loadSessionHistory(
    sessionId: string,
    projectId: string,
    projectPath?: string,
  ): Promise<unknown[]> {
    const configDir = findProjectConfigDir(accounts, projectPath);
    if (!configDir) {
      throw new NoAccountError(
        noAccountMessage(projectId, projectPath),
        projectPath,
        projectId,
      );
    }

    const projectsDir = path.join(configDir, 'projects');
    const filePath = path.join(projectsDir, projectId, `${sessionId}.jsonl`);
    if (await pathExists(filePath)) return readJsonlFile(filePath);

    const resolvedPath =
      projectPath ?? (await recoverProjectPathAsync(path.join(projectsDir, projectId), projectId));
    for (const dirName of await findProjectDirsForPath(projectsDir, resolvedPath)) {
      if (dirName === projectId) continue;
      const sibling = path.join(projectsDir, dirName, `${sessionId}.jsonl`);
      if (await pathExists(sibling)) return readJsonlFile(sibling);
    }

    return [];
  }

  async function loadAgentSessionHistory(sessionId: string): Promise<unknown[]> {
    for (const dir of getConfigDirs(accounts)) {
      const projectsDir = path.join(dir, 'projects');

      let projectEntries: fs.Dirent[];
      try {
        projectEntries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      const candidates = projectEntries
        .filter((e) => e.isDirectory())
        .map((e) => path.join(projectsDir, e.name, `${sessionId}.jsonl`));
      const present = await mapLimit(candidates, 16, pathExists);
      const hit = candidates.find((_, i) => present[i]);
      if (hit) return readJsonlFile(hit);
    }

    return [];
  }

  async function deleteSession(
    sessionId: string,
    projectId: string,
    projectPath?: string,
  ): Promise<void> {
    const configDir = findProjectConfigDir(accounts, projectPath);
    if (!configDir) {
      throw new NoAccountError(
        noAccountMessage(projectId, projectPath),
        projectPath,
        projectId,
      );
    }

    const projectDir = path.join(configDir, 'projects', projectId);
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) {
      throw new Error(
        `deleteSession: JSONL not found at ${jsonlPath}`,
      );
    }

    fs.unlinkSync(jsonlPath);

    const sidecarPath = path.join(projectDir, `${sessionId}.summary.json`);
    const todoPath = path.join(projectDir, `${sessionId}.todo.json`);
    for (const ridePath of [sidecarPath, todoPath]) {
      try {
        fs.unlinkSync(ridePath);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          console.warn(`[claude] deleteSession: failed to remove ${ridePath}:`, err);
        }
      }
    }
  }

  // A single path segment only, so a malformed call cannot rm -rf a sibling.
  function assertSafeProjectId(projectId: string): void {
    if (typeof projectId !== 'string') {
      throw new Error('deleteProject: projectId must be a string');
    }
    const trimmed = projectId.trim();
    if (trimmed.length === 0) {
      throw new Error('deleteProject: projectId must not be empty');
    }
    if (trimmed === '.' || trimmed === '..') {
      throw new Error(`deleteProject: refusing traversal projectId "${projectId}"`);
    }
    if (/[\\/\0]/.test(projectId) || projectId.includes('..')) {
      throw new Error(`deleteProject: invalid projectId "${projectId}"`);
    }
  }

  async function deleteProject(args: {
    accountId: number;
    projectId: string;
  }): Promise<{ deletedPath: string }> {
    const { accountId, projectId } = args;
    assertSafeProjectId(projectId);

    // By id, never accounts.resolve(): a path rule could jump to another account.
    const account = accounts.listAccounts().find((a) => a.id === accountId);
    if (!account) {
      throw new Error(`deleteProject: unknown account id ${accountId}`);
    }

    const projectsDir = path.join(account.config_dir, 'projects');
    const projectDir = path.join(projectsDir, projectId);
    // Resolve before deleting: recoverProjectPath reads the JSONLs inside.
    const resolvedPath = await recoverProjectPathAsync(projectDir, projectId);
    // Delete every sibling dir, or one resurrects as a duplicate row.
    const dirNames = await findProjectDirsForPath(projectsDir, resolvedPath);
    const targets = dirNames.length > 0 ? dirNames : [projectId];

    // Unpin first, or a later project at this path is born pinned.
    pins.setPinned(resolvedPath, false);
    for (const dirName of targets) {
      fs.rmSync(path.join(projectsDir, dirName), { recursive: true, force: true });
    }
    return { deletedPath: projectDir };
  }

  async function getClaudeSettings(
    opts?: ClaudeSettingsOpts,
  ): Promise<Record<string, unknown>> {
    if (!opts?.configDir) {
      throw new Error('configDir is required for getClaudeSettings');
    }
    const configDir = opts.configDir;
    const settingsPath = path.join(configDir, 'settings.json');

    if (!fs.existsSync(settingsPath)) return {};

    try {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  async function saveClaudeSettings(
    settings: Record<string, unknown>,
    opts?: ClaudeSettingsOpts,
  ): Promise<void> {
    if (!opts?.configDir) {
      throw new Error('configDir is required for saveClaudeSettings');
    }
    const configDir = opts.configDir;
    const settingsPath = path.join(configDir, 'settings.json');

    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch {
      // ignore write errors
    }
  }

  async function getSystemPrompt(opts?: ClaudeSettingsOpts): Promise<string> {
    if (!opts?.configDir) {
      throw new Error('configDir is required for getSystemPrompt');
    }
    const filePath = path.join(opts.configDir, 'CLAUDE.md');
    return readClaudeMdFile(filePath);
  }

  async function saveSystemPrompt(content: string, opts?: ClaudeSettingsOpts): Promise<void> {
    if (!opts?.configDir) {
      throw new Error('configDir is required for saveSystemPrompt');
    }
    const filePath = path.join(opts.configDir, 'CLAUDE.md');
    return saveClaudeMdFile(filePath, content);
  }

  async function checkClaudeVersion(): Promise<ClaudeVersionStatus> {
    const binaryPath = claudeOnPath();

    if (!binaryPath) {
      return { installed: false, version: null, path: null };
    }

    return { installed: true, version: await probeBinaryVersion(binaryPath), path: binaryPath };
  }


  async function readClaudeMdFile(filePath: string): Promise<string> {
    try {
      if (!fs.existsSync(filePath)) return '';
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  async function saveClaudeMdFile(filePath: string, content: string): Promise<void> {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
    } catch {
      // ignore write errors
    }
  }

  async function getHooksConfig(
    scope: 'user' | 'project',
    opts?: ClaudeSettingsOpts & { projectPath?: string },
  ): Promise<Record<string, unknown>> {
    // configDir is required for user scope: never silently read ~/.claude.
    if (scope === 'user' && !opts?.configDir) {
      throw new Error('configDir is required for getHooksConfig(user)');
    }
    if (scope === 'project' && opts?.projectPath) {
      const settingsPath = path.join(opts.projectPath, '.claude', 'settings.json');
      if (!fs.existsSync(settingsPath)) return {};
      try {
        const content = fs.readFileSync(settingsPath, 'utf-8');
        const parsed: unknown = JSON.parse(content);
        if (typeof parsed === 'object' && parsed !== null) {
          return ((parsed as Record<string, unknown>).hooks as Record<string, unknown>) ?? {};
        }
        return {};
      } catch {
        return {};
      }
    }

    const settings = await getClaudeSettings(opts);
    return (settings.hooks as Record<string, unknown>) ?? {};
  }

  async function updateHooksConfig(
    scope: 'user' | 'project',
    hooks: Record<string, unknown>,
    opts?: ClaudeSettingsOpts & { projectPath?: string },
  ): Promise<void> {
    if (scope === 'user' && !opts?.configDir) {
      throw new Error('configDir is required for updateHooksConfig(user)');
    }
    if (scope === 'project' && opts?.projectPath) {
      const settingsDir = path.join(opts.projectPath, '.claude');
      const settingsPath = path.join(settingsDir, 'settings.json');

      let existing: Record<string, unknown> = {};
      try {
        if (fs.existsSync(settingsPath)) {
          const content = fs.readFileSync(settingsPath, 'utf-8');
          const parsed: unknown = JSON.parse(content);
          if (typeof parsed === 'object' && parsed !== null) {
            existing = parsed as Record<string, unknown>;
          }
        }
      } catch {
        // start fresh
      }

      try {
        fs.mkdirSync(settingsDir, { recursive: true });
        fs.writeFileSync(
          settingsPath,
          JSON.stringify({ ...existing, hooks }, null, 2),
          'utf-8',
        );
      } catch {
        // ignore write errors
      }
      return;
    }

    const settings = await getClaudeSettings(opts);
    await saveClaudeSettings({ ...settings, hooks }, opts);
  }

  function validateHookCommand(command: string): { valid: boolean; message: string } {
    if (!command?.trim()) {
      return { valid: false, message: 'Command must not be empty' };
    }
    return { valid: true, message: 'OK' };
  }

  async function getMergedHooksConfig(
    projectPath: string,
    opts?: ClaudeSettingsOpts,
  ): Promise<Record<string, unknown>> {
    if (!opts?.configDir) {
      throw new Error('configDir is required for getMergedHooksConfig');
    }
    const userHooks = await getHooksConfig('user', opts);
    const projectHooks = await getHooksConfig('project', { ...opts, projectPath });

    return { ...userHooks, ...projectHooks };
  }

  async function getCliUsage(configDir?: string): Promise<string> {
    const binary = claudeOnPath();
    if (!binary) return 'Claude CLI not found';

    // Refuse without configDir: falling back to process.env leaks to ~/.claude.
    let env: NodeJS.ProcessEnv;
    try {
      env = buildClaudeEnv(configDir);
    } catch (err) {
      const message = (err as Error | undefined)?.message;
      console.error('[claude] getCliUsage refused:', message);
      return `Failed to fetch usage: ${message ?? 'configDir invalid'}`;
    }

    try {
      const output = await execFileText(
        binary,
        ['-p', '/usage', '--output-format', 'json'],
        { timeout: 15000, env },
      );
      const parsed = JSON.parse(output.trim()) as { result?: string };
      return parsed.result ?? 'No usage data returned';
    } catch (err) {
      const message = (err as Error | undefined)?.message;
      console.error('[claude] getCliUsage failed:', message);
      return `Failed to fetch usage: ${message ?? 'unknown error'}`;
    }
  }

  return {
    getHomeDirectory,
    getDefaultModel,
    listProjects,
    setProjectPinned,
    createProject,
    getProjectSessions,
    warmSessionMetadata,
    loadSessionHistory,
    loadAgentSessionHistory,
    deleteSession,
    deleteProject,
    getClaudeSettings,
    saveClaudeSettings,
    getSystemPrompt,
    saveSystemPrompt,
    checkClaudeVersion,
    readClaudeMdFile,
    saveClaudeMdFile,
    getHooksConfig,
    updateHooksConfig,
    validateHookCommand,
    getMergedHooksConfig,
    getCliUsage,
  };
}
