// Claude service — handles project listing, session history, settings,
// CLAUDE.md files, hooks config, and version checking.
// This is a Node.js/Electron port of the Rust commands/claude.rs.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from './database';
import type { AccountsService } from './accounts';
import { buildClaudeEnv } from './util/claude-env';

/**
 * Thrown when an operation needs a Claude account for a project path but
 * `accounts.resolve(projectPath)` returns null. There is NO silent fallback
 * to a "default" account or to `~/.claude` — either a path rule / explicit
 * project override binds the project to an account, or this error is raised
 * so the renderer can surface a prominent "no account configured" banner
 * with a link to Account Settings.
 *
 * `code` is used by the IPC layer + renderer to recognize the error type
 * after structured-clone (Error message is preserved across IPC; subclass
 * identity is not).
 */
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

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  path: string;
  sessions: string[];
  created_at: number;
  /** Newest Claude session JSONL mtime for this project, in Unix
   *  seconds. Undefined when the project has no session JSONLs yet.
   *  The Projects list surfaces this as "Last activity" — i.e. when
   *  Claude last touched this project, not when files in the working
   *  tree last changed. */
  most_recent_session?: number;
  account_id?: number;
  account_name?: string;
}

export interface Session {
  id: string;
  project_id: string;
  project_path: string;
  todo_data?: unknown;
  created_at: number;
  first_message?: string;
  first_timestamp?: string;
  last_timestamp?: string;
  /** @deprecated retained for renderer migration; use last_timestamp instead. */
  message_timestamp?: string;
  /** Size of the session JSONL in bytes (from fs.stat). Used downstream by
   *  the summary refresh affordance to decide whether anything has changed
   *  since the last summary generation. */
  file_size_bytes?: number;
}

export interface ClaudeMdFile {
  absolute_path: string;
  relative_path: string;
  size: number;
  modified: number;
}

export interface ClaudeVersionStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
}

export interface ClaudeSettingsOpts {
  /** Override the config dir to read/write. Defaults to ~/.claude */
  configDir?: string;
}

export interface ClaudeService {
  getHomeDirectory(): string;

  listProjects(): Promise<Project[]>;
  createProject(projectPath: string): Project;
  getProjectSessions(projectId: string, projectPath?: string): Promise<Session[]>;

  loadSessionHistory(
    sessionId: string,
    projectId: string,
    projectPath?: string,
  ): Promise<unknown[]>;
  loadAgentSessionHistory(sessionId: string): Promise<unknown[]>;

  /**
   * Delete a session JSONL plus its known ride-along files
   * (`*.summary.json`, `*.todo.json`). Throws when the project's config
   * dir cannot be resolved or when the JSONL file is missing — the
   * caller should surface those as user-facing errors. Sidecar absence
   * is silent (best-effort cascade).
   */
  deleteSession(
    sessionId: string,
    projectId: string,
    projectPath?: string,
  ): Promise<void>;

  /**
   * Recursively delete `<configDir>/projects/<projectId>` for the account
   * identified by `accountId`. Returns the absolute path that was removed
   * (or attempted) so the caller can toast / log.
   *
   * Idempotent: a missing project directory resolves quietly. Throws when
   * the account id is unknown or when `projectId` is not a single safe
   * path segment (rejects `''`, `.`, `..`, anything containing `/`, `\`,
   * or `\0`). The renderer is bound to per-row `account_id` so this
   * intentionally does not consult path rules — deleting a project under
   * a specific account must not bleed into a sibling account whose path
   * rule happens to match.
   */
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

  findClaudeMdFiles(projectPath: string): Promise<ClaudeMdFile[]>;
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

  /** Run `/usage` via the CLI and return the result text (Max accounts only). */
  getCliUsage(configDir?: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse all valid JSON lines from a file, skipping malformed lines. */
function readJsonlFile(filePath: string): unknown[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const results: unknown[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        results.push(JSON.parse(trimmed));
      } catch {
        // skip malformed lines — never throw
      }
    }
    return results;
  } catch {
    return [];
  }
}

/** Get the default claude config dir (~/.claude). */
/**
 * Distinct config dirs across all accounts. Used by listing/scanning paths
 * that legitimately span every account (e.g. listProjects, the agent-history
 * lookup that has no projectPath to anchor on). There is NO synthetic
 * `~/.claude` entry — only what's registered in the accounts table.
 */
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

/**
 * Resolve the config dir that owns a given project, strictly via the accounts
 * service. Returns null when the project path cannot be resolved (no path rule
 * and no explicit override) — callers turn that into a NoAccountError.
 *
 * Important: this no longer scans the filesystem. A stray `projects/<id>/`
 * directory left under the wrong account's configDir (e.g. from a one-off run
 * under the wrong CLAUDE_CONFIG_DIR) MUST NOT change which account owns the
 * project. The bound account is the source of truth — see CLAUDE.md "Multi-
 * Account Rules" and the WIN-project bug regression in claude.test.ts.
 */
function findProjectConfigDir(
  accounts: AccountsService,
  projectPath: string | undefined,
): string | null {
  if (!projectPath) return null;
  try {
    const resolved = accounts.resolve(projectPath);
    return resolved?.config_dir ?? null;
  } catch {
    return null;
  }
}

/**
 * Naive decode of a project ID (Claude-style path encoding) to the
 * original file path. Claude Code encodes by stripping the leading '/'
 * and replacing all '/' with '-'. The encoding is **lossy** —
 * `/Users/g/pi-tuitive-fe` and `/Users/g/pi/tuitive/fe` both encode to
 * `-Users-g-pi-tuitive-fe`. Use `recoverProjectPath()` whenever the
 * project dir is available; this naive form is the fallback for when
 * no JSONL exists yet.
 */
function decodeProjectId(projectId: string): string {
  // Strip leading dash if present, then replace all dashes with slashes.
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
function recoverProjectPath(projectDir: string, projectId: string): string {
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

function encodeProjectId(projectPath: string): string {
  // Claude Code convention: leading dash + slashes replaced with dashes
  // e.g., /Users/foo/bar → -Users-foo-bar
  return projectPath.replace(/\//g, '-');
}

/**
 * Walk a JSONL session file once and pull out:
 *  - the first user-text message (skipping meta / command-tag noise),
 *  - the ISO timestamp of the first JSONL entry that has a `timestamp` field,
 *  - the ISO timestamp of the last JSONL entry that has a `timestamp` field.
 *
 * Returning all three from one pass lets `getProjectSessions` build the row's
 * "first activity – last activity" range without extra reads.
 */
function extractSessionMetadata(filePath: string): {
  firstMessage?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
} {
  const entries = readJsonlFile(filePath);
  let firstMessage: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;

    // Track first/last timestamps across every entry that carries one,
    // regardless of type — assistant turns, tool results, and meta entries
    // all bracket the session's wall-clock activity.
    const ts = obj['timestamp'];
    if (typeof ts === 'string') {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    if (firstMessage) continue; // already have the first message text

    if (obj['type'] !== 'user') continue;
    if (obj['isMeta']) continue;

    const message = obj['message'] as Record<string, unknown> | undefined;
    if (!message) continue;
    const content = message['content'];

    let text: string | undefined;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === 'object' && block !== null) {
          const b = block as Record<string, unknown>;
          if (b['type'] === 'text' && typeof b['text'] === 'string') {
            text = b['text'] as string;
            break;
          }
        }
      }
    }

    if (!text) continue;

    if (
      text.includes('<local-command-caveat>') ||
      text.includes('<system-reminder>') ||
      text.includes('<command-name>')
    ) {
      continue;
    }

    firstMessage = text.trim().slice(0, 200);
  }

  return { firstMessage, firstTimestamp, lastTimestamp };
}

const EXEC_OPTIONS = {
  timeout: 5000,
  encoding: 'utf-8' as const,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createClaudeService(db: Database, accounts: AccountsService): ClaudeService {
  // db is accepted for future use (e.g. caching, settings storage)
  void db;

  // -------------------------------------------------------------------------
  // getHomeDirectory
  // -------------------------------------------------------------------------

  function getHomeDirectory(): string {
    return os.homedir();
  }

  // -------------------------------------------------------------------------
  // createProject
  // -------------------------------------------------------------------------

  function createProject(projectPath: string): Project {
    const projectId = encodeProjectId(projectPath);

    // Resolve which account's config dir to use
    const account = accounts.resolve(projectPath);
    if (!account) {
      throw new Error(`No account resolved for project ${projectPath}. Configure an account or path rule first.`);
    }
    const configDir = account.config_dir;

    // Ensure the project directory exists
    const projectDir = path.join(configDir, 'projects', projectId);
    fs.mkdirSync(projectDir, { recursive: true });

    return {
      id: projectId,
      path: projectPath,
      sessions: [],
      created_at: Math.floor(Date.now() / 1000),
      account_id: account?.id,
      account_name: account?.name,
    };
  }

  // -------------------------------------------------------------------------
  // listProjects
  // -------------------------------------------------------------------------

  async function listProjects(): Promise<Project[]> {
    const projects: Project[] = [];
    const seenIds = new Set<string>();

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
            const stat = fs.statSync(path.join(projectDir, se.name));
            const mtime = stat.mtimeMs;
            if (mostRecent === undefined || mtime > mostRecent) {
              mostRecent = mtime;
            }
            if (stat.birthtimeMs < createdAt) {
              createdAt = stat.birthtimeMs;
            }
          } catch {
            // ignore stat errors
          }
        }

        const projectPath = recoverProjectPath(projectDir, projectId);
        projects.push({
          id: projectId,
          path: projectPath,
          sessions,
          created_at: Math.floor(createdAt / 1000),
          most_recent_session:
            mostRecent !== undefined ? Math.floor(mostRecent / 1000) : undefined,
          account_id: account.id,
          account_name: account.name,
        });
      }
    }

    // Sort by most_recent_session DESC (undefined last)
    projects.sort((a, b) => {
      const aTime = a.most_recent_session ?? 0;
      const bTime = b.most_recent_session ?? 0;
      return bTime - aTime;
    });

    return projects;
  }

  // -------------------------------------------------------------------------
  // getProjectSessions
  // -------------------------------------------------------------------------

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

    const projectDir = path.join(configDir, 'projects', projectId);
    // Account exists but no on-disk sessions yet — legitimate empty state.
    if (!fs.existsSync(projectDir)) return [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const sessions: Session[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.replace(/\.jsonl$/, '');
      const filePath = path.join(projectDir, entry.name);

      let createdAt = Date.now();
      let mtimeFallback: string | undefined;
      let fileSize: number | undefined;

      try {
        const stat = fs.statSync(filePath);
        createdAt = stat.birthtimeMs;
        mtimeFallback = new Date(stat.mtimeMs).toISOString();
        fileSize = stat.size;
      } catch {
        // ignore
      }

      const { firstMessage, firstTimestamp, lastTimestamp } =
        extractSessionMetadata(filePath);
      const decodedPath = projectPath ?? recoverProjectPath(projectDir, projectId);

      sessions.push({
        id: sessionId,
        project_id: projectId,
        project_path: decodedPath,
        created_at: Math.floor(createdAt / 1000),
        first_message: firstMessage,
        first_timestamp: firstTimestamp,
        last_timestamp: lastTimestamp ?? mtimeFallback,
        message_timestamp: lastTimestamp ?? mtimeFallback,
        file_size_bytes: fileSize,
      });
    }

    // Sort by created_at DESC
    sessions.sort((a, b) => b.created_at - a.created_at);
    return sessions;
  }

  // -------------------------------------------------------------------------
  // loadSessionHistory
  // -------------------------------------------------------------------------

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

    const filePath = path.join(configDir, 'projects', projectId, `${sessionId}.jsonl`);
    if (!fs.existsSync(filePath)) return [];

    return readJsonlFile(filePath);
  }

  // -------------------------------------------------------------------------
  // loadAgentSessionHistory
  // -------------------------------------------------------------------------

  async function loadAgentSessionHistory(sessionId: string): Promise<unknown[]> {
    // Search all config dirs for any project dir containing this session file
    for (const dir of getConfigDirs(accounts)) {
      const projectsDir = path.join(dir, 'projects');
      if (!fs.existsSync(projectsDir)) continue;

      let projectEntries: fs.Dirent[];
      try {
        projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const projectEntry of projectEntries) {
        if (!projectEntry.isDirectory()) continue;
        const candidate = path.join(
          projectsDir,
          projectEntry.name,
          `${sessionId}.jsonl`,
        );
        if (fs.existsSync(candidate)) {
          return readJsonlFile(candidate);
        }
      }
    }

    return [];
  }

  // -------------------------------------------------------------------------
  // deleteSession
  // -------------------------------------------------------------------------

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

    // Hard delete the JSONL first — that's the user's source-of-truth
    // signal that the session is gone. Ride-along sidecars are
    // best-effort: if any of them is missing or unlinkable for an
    // unrelated reason we don't want to half-delete the session.
    fs.unlinkSync(jsonlPath);

    const sidecarPath = path.join(projectDir, `${sessionId}.summary.json`);
    const todoPath = path.join(projectDir, `${sessionId}.todo.json`);
    for (const ridePath of [sidecarPath, todoPath]) {
      try {
        fs.unlinkSync(ridePath);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          // Surface anything other than "file wasn't there anyway" so
          // we don't silently leak corrupt sidecar state — but the JSONL
          // is already gone at this point, so we just log rather than
          // re-throw and leave the row half-deleted.
          console.warn(`[claude] deleteSession: failed to remove ${ridePath}:`, err);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // deleteProject
  // -------------------------------------------------------------------------

  // A safe project ID is a single non-empty path segment with no separators
  // and no traversal sneakiness. Claude's encoded project IDs look like
  // "-Users-gregorychristie-Repos-foo" — leading dash, then dashes for
  // every internal slash. Anything else is rejected so a malformed renderer
  // call cannot rm-rf a sibling directory.
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

    // Bind via id, not path resolution — the renderer row already knows
    // which account this project lives under, and using accounts.resolve()
    // would silently jump to a different account whose path rule wins.
    const account = accounts.listAccounts().find((a) => a.id === accountId);
    if (!account) {
      throw new Error(`deleteProject: unknown account id ${accountId}`);
    }

    const projectDir = path.join(account.config_dir, 'projects', projectId);
    fs.rmSync(projectDir, { recursive: true, force: true });
    return { deletedPath: projectDir };
  }

  // -------------------------------------------------------------------------
  // getClaudeSettings / saveClaudeSettings
  // -------------------------------------------------------------------------

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
      const parsed = JSON.parse(content);
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

  // -------------------------------------------------------------------------
  // getSystemPrompt / saveSystemPrompt
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // checkClaudeVersion
  // -------------------------------------------------------------------------

  async function checkClaudeVersion(): Promise<ClaudeVersionStatus> {
    // Try to locate the claude binary via `which`
    let binaryPath: string | null = null;

    try {
      const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
      const output = execSync(cmd, EXEC_OPTIONS);
      if (typeof output === 'string') {
        const trimmed = output.trim().split('\n')[0].trim();
        if (trimmed && fs.existsSync(trimmed)) {
          binaryPath = trimmed;
        }
      }
    } catch {
      // not found via which
    }

    if (!binaryPath) {
      return { installed: false, version: null, path: null };
    }

    try {
      const versionOutput = execSync(`"${binaryPath}" --version`, EXEC_OPTIONS);
      const version =
        typeof versionOutput === 'string' ? versionOutput.trim() : null;
      return { installed: true, version, path: binaryPath };
    } catch {
      // binary found but --version failed (unusual)
      return { installed: true, version: null, path: binaryPath };
    }
  }

  // -------------------------------------------------------------------------
  // findClaudeMdFiles
  // -------------------------------------------------------------------------

  async function findClaudeMdFiles(projectPath: string): Promise<ClaudeMdFile[]> {
    const results: ClaudeMdFile[] = [];

    const tryAdd = (absolutePath: string, relativePath: string) => {
      if (!fs.existsSync(absolutePath)) return;
      try {
        const stat = fs.statSync(absolutePath);
        results.push({
          absolute_path: absolutePath,
          relative_path: relativePath,
          size: stat.size,
          modified: Math.floor(stat.mtimeMs / 1000),
        });
      } catch {
        // ignore stat errors
      }
    };

    // 1. Project root CLAUDE.md
    tryAdd(path.join(projectPath, 'CLAUDE.md'), 'CLAUDE.md');

    // 2. Project .claude/CLAUDE.md
    tryAdd(path.join(projectPath, '.claude', 'CLAUDE.md'), '.claude/CLAUDE.md');

    // 3. Recursive search for CLAUDE.md in src/ and other subdirs (depth-limited)
    function walk(dir: string, relBase: string, depth: number) {
      if (depth > 3) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
        const fullPath = path.join(dir, entry.name);
        const relPath = path.join(relBase, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, relPath, depth + 1);
        } else if (entry.name === 'CLAUDE.md') {
          if (!results.some(r => r.absolute_path === fullPath)) {
            tryAdd(fullPath, relPath);
          }
        }
      }
    }
    walk(projectPath, '', 0);

    return results;
  }

  // -------------------------------------------------------------------------
  // readClaudeMdFile / saveClaudeMdFile
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // getHooksConfig / updateHooksConfig
  // -------------------------------------------------------------------------

  async function getHooksConfig(
    scope: 'user' | 'project',
    opts?: ClaudeSettingsOpts & { projectPath?: string },
  ): Promise<Record<string, unknown>> {
    // Require configDir for the user scope so we never silently read ~/.claude.
    // Project scope doesn't need it — it reads <projectPath>/.claude/settings.json.
    if (scope === 'user' && !opts?.configDir) {
      throw new Error('configDir is required for getHooksConfig(user)');
    }
    if (scope === 'project' && opts?.projectPath) {
      // Read from project .claude/settings.json
      const settingsPath = path.join(opts.projectPath, '.claude', 'settings.json');
      if (!fs.existsSync(settingsPath)) return {};
      try {
        const content = fs.readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (typeof parsed === 'object' && parsed !== null) {
          return ((parsed as Record<string, unknown>)['hooks'] as Record<string, unknown>) ?? {};
        }
        return {};
      } catch {
        return {};
      }
    }

    // user scope
    const settings = await getClaudeSettings(opts);
    return (settings['hooks'] as Record<string, unknown>) ?? {};
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
          const parsed = JSON.parse(content);
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

    // user scope
    const settings = await getClaudeSettings(opts);
    await saveClaudeSettings({ ...settings, hooks }, opts);
  }

  // -------------------------------------------------------------------------
  // validateHookCommand
  // -------------------------------------------------------------------------

  function validateHookCommand(command: string): { valid: boolean; message: string } {
    if (!command || !command.trim()) {
      return { valid: false, message: 'Command must not be empty' };
    }
    return { valid: true, message: 'OK' };
  }

  // -------------------------------------------------------------------------
  // getMergedHooksConfig
  // -------------------------------------------------------------------------

  async function getMergedHooksConfig(
    projectPath: string,
    opts?: ClaudeSettingsOpts,
  ): Promise<Record<string, unknown>> {
    if (!opts?.configDir) {
      throw new Error('configDir is required for getMergedHooksConfig');
    }
    const userHooks = await getHooksConfig('user', opts);
    const projectHooks = await getHooksConfig('project', { ...opts, projectPath });

    // Shallow merge: project hooks override user hooks per key
    return { ...userHooks, ...projectHooks };
  }

  // -------------------------------------------------------------------------
  // CLI usage
  // -------------------------------------------------------------------------

  async function getCliUsage(configDir?: string): Promise<string> {
    // Locate the binary the same way checkClaudeVersion does
    let binary: string | null = null;
    try {
      const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
      const out = execSync(cmd, EXEC_OPTIONS);
      if (typeof out === 'string') {
        const trimmed = out.trim().split('\n')[0].trim();
        if (trimmed && fs.existsSync(trimmed)) binary = trimmed;
      }
    } catch { /* not found */ }
    if (!binary) return 'Claude CLI not found';

    // Previously fell back to process.env's CLAUDE_CONFIG_DIR when configDir
    // was missing — that silently leaks to ~/.claude when OmniFex is launched
    // outside a shell that sets it. Refuse instead so a renderer regression
    // surfaces as a visible error rather than invisible state-corruption.
    let env: NodeJS.ProcessEnv;
    try {
      env = buildClaudeEnv(configDir);
    } catch (err: any) {
      console.error('[claude] getCliUsage refused:', err?.message);
      return `Failed to fetch usage: ${err?.message ?? 'configDir invalid'}`;
    }

    try {
      const output = execSync(
        `"${binary}" -p "/usage" --output-format json`,
        { timeout: 15000, encoding: 'utf-8', env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const parsed = JSON.parse(output.trim());
      return parsed.result ?? 'No usage data returned';
    } catch (err: any) {
      console.error('[claude] getCliUsage failed:', err?.message);
      return `Failed to fetch usage: ${err?.message ?? 'unknown error'}`;
    }
  }

  // -------------------------------------------------------------------------
  // Return service
  // -------------------------------------------------------------------------

  return {
    getHomeDirectory,
    listProjects,
    createProject,
    getProjectSessions,
    loadSessionHistory,
    loadAgentSessionHistory,
    deleteSession,
    deleteProject,
    getClaudeSettings,
    saveClaudeSettings,
    getSystemPrompt,
    saveSystemPrompt,
    checkClaudeVersion,
    findClaudeMdFiles,
    readClaudeMdFile,
    saveClaudeMdFile,
    getHooksConfig,
    updateHooksConfig,
    validateHookCommand,
    getMergedHooksConfig,
    getCliUsage,
  };
}
