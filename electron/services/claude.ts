// Claude service — handles project listing, session history, settings,
// CLAUDE.md files, hooks config, and version checking.
// This is a Node.js/Electron port of the Rust commands/claude.rs.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from './database';
import type { AccountsService } from './accounts';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  path: string;
  sessions: string[];
  created_at: number;
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
  message_timestamp?: string;
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
  getMergedHooksConfig(projectPath: string): Promise<Record<string, unknown>>;
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
function defaultConfigDir(): string {
  return path.join(os.homedir(), '.claude');
}

/** Get all config dirs from accounts, plus default ~/.claude as fallback. */
function getConfigDirs(accounts: AccountsService): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();

  for (const account of accounts.listAccounts()) {
    if (!seen.has(account.config_dir)) {
      seen.add(account.config_dir);
      dirs.push(account.config_dir);
    }
  }

  const def = defaultConfigDir();
  if (!seen.has(def)) {
    dirs.push(def);
  }

  return dirs;
}

/**
 * Find which config dir contains `projects/$projectId/`.
 * Falls back to resolving via projectPath if provided.
 */
function findProjectConfigDir(
  projectId: string,
  accounts: AccountsService,
  projectPath?: string,
): string | null {
  // Search all known config dirs first
  for (const dir of getConfigDirs(accounts)) {
    const candidate = path.join(dir, 'projects', projectId);
    if (fs.existsSync(candidate)) {
      return dir;
    }
  }

  // Try resolving via account matching
  if (projectPath) {
    try {
      const resolved = accounts.resolve(projectPath);
      if (resolved) {
        const candidate = path.join(resolved.config_dir, 'projects', projectId);
        if (fs.existsSync(candidate)) {
          return resolved.config_dir;
        }
      }
    } catch {
      // ignore resolution errors
    }
  }

  return null;
}

/**
 * Decode a project ID (Claude-style path encoding) to the original file path.
 * Claude encodes project paths by replacing leading '/' with '' and '/' with '-'.
 * We reverse: decode '-' as '/' and prepend '/'.
 */
function decodeProjectId(projectId: string): string {
  // Strip leading dash if present, then replace all dashes with slashes.
  // Result always starts with "/" so it's an absolute path.
  const stripped = projectId.replace(/^-+/, '');
  return '/' + stripped.replace(/-/g, '/');
}

function encodeProjectId(projectPath: string): string {
  // Claude Code convention: leading dash + slashes replaced with dashes
  // e.g., /Users/foo/bar → -Users-foo-bar
  return projectPath.replace(/\//g, '-');
}

/** Get the first user/human message text from a JSONL session file. */
function extractFirstMessage(filePath: string): string | undefined {
  const entries = readJsonlFile(filePath);
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;

    // Only user messages with type === 'user', skip meta/system-injected ones
    if (obj['type'] !== 'user') continue;
    if (obj['isMeta']) continue;

    // Actual message content is nested under message.content
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

    // Skip command caveats, system reminders, tool results, and /exit commands
    if (
      text.includes('<local-command-caveat>') ||
      text.includes('<system-reminder>') ||
      text.includes('<command-name>')
    ) {
      continue;
    }

    return text.trim().slice(0, 200);
  }
  return undefined;
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
      console.warn(`[claude] No account resolved for project ${projectPath} — falling back to ~/.claude`);
    }
    const configDir = account?.config_dir ?? defaultConfigDir();

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

        projects.push({
          id: projectId,
          path: decodeProjectId(projectId),
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
    const configDir = findProjectConfigDir(projectId, accounts, projectPath);
    if (!configDir) return [];

    const projectDir = path.join(configDir, 'projects', projectId);
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
      let messageTimestamp: string | undefined;

      try {
        const stat = fs.statSync(filePath);
        createdAt = stat.birthtimeMs;
        messageTimestamp = new Date(stat.mtimeMs).toISOString();
      } catch {
        // ignore
      }

      const firstMessage = extractFirstMessage(filePath);
      const decodedPath = projectPath ?? decodeProjectId(projectId);

      sessions.push({
        id: sessionId,
        project_id: projectId,
        project_path: decodedPath,
        created_at: Math.floor(createdAt / 1000),
        first_message: firstMessage,
        message_timestamp: messageTimestamp,
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
    const configDir = findProjectConfigDir(projectId, accounts, projectPath);
    if (!configDir) return [];

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
  // getClaudeSettings / saveClaudeSettings
  // -------------------------------------------------------------------------

  async function getClaudeSettings(
    opts?: ClaudeSettingsOpts,
  ): Promise<Record<string, unknown>> {
    const configDir = opts?.configDir ?? defaultConfigDir();
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
    const configDir = opts?.configDir ?? defaultConfigDir();
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
    const configDir = opts?.configDir ?? defaultConfigDir();
    const filePath = path.join(configDir, 'CLAUDE.md');
    return readClaudeMdFile(filePath);
  }

  async function saveSystemPrompt(content: string, opts?: ClaudeSettingsOpts): Promise<void> {
    const configDir = opts?.configDir ?? defaultConfigDir();
    const filePath = path.join(configDir, 'CLAUDE.md');
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
  ): Promise<Record<string, unknown>> {
    const userHooks = await getHooksConfig('user');
    const projectHooks = await getHooksConfig('project', { projectPath });

    // Shallow merge: project hooks override user hooks per key
    return { ...userHooks, ...projectHooks };
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
  };
}
