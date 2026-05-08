import { apiCall } from './apiAdapter';
import type { HooksConfiguration } from '@/types/hooks';

/**
 * Represents a project in the ~/.claude/projects directory
 */
export interface Project {
  /** The project ID (derived from the directory name) */
  id: string;
  /** The original project path (decoded from the directory name) */
  path: string;
  /** List of session IDs (JSONL file names without extension) */
  sessions: string[];
  /** Unix timestamp when the project directory was created */
  created_at: number;
  /** Unix timestamp of the newest Claude session JSONL mtime for this
   *  project (undefined if the project has no sessions yet). The
   *  Projects list surfaces this as "Last activity" — i.e. when you
   *  last *talked to Claude* about this project, not when files in
   *  the working tree last changed. */
  most_recent_session?: number;
  /** Account ID this project belongs to */
  account_id?: number;
  /** Account name for display */
  account_name?: string;
}

/**
 * Represents a Claude account (e.g., personal, work)
 */
export interface SessionDefaults {
  model?: string;
  thinkingConfig?: 'adaptive' | 'budget' | 'disabled';
  permissionMode?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface Account {
  id: number;
  name: string;
  config_dir: string;
  // No is_default field — there is no default account. See migration v8 in
  // electron/services/database.ts. Resolution is path rule / project override
  // only; failure raises NoAccountError.
  /** Account type: "max" (no cost), "enterprise", "pro", "free" */
  account_type: string;
  color: string | null;
  icon: string | null;
  session_defaults?: SessionDefaults;
  /**
   * Optional per-account override for which `claude` binary or wrapper to
   * spawn. Defaults to whatever `findClaudeBinary` resolves on PATH when null.
   * Shell aliases are not supported — paste a resolved path.
   */
  cli_path: string | null;
  created_at: string;
  updated_at: string;
  /** Per-session summary opt-in. Default false. */
  summarizeOnClose?: boolean;
  /** Model id used for summarization (e.g. 'haiku', 'sonnet'). Null
   *  means no model selected — feature stays off regardless of toggle. */
  summaryModel?: string | null;
}

/**
 * Structured form of the rich `/usage` output captured by spawning claude in
 * a PTY (see `electron/services/usage-runner.ts`). Mirrors the parser shape.
 */
export interface UsageRunData {
  session: {
    cost_usd: number;
    api_duration_s: number;
    wall_duration_s: number;
    code_added: number;
    code_removed: number;
    input_tokens: number;
    output_tokens: number;
    cache_read: number;
    cache_write: number;
  };
  windows: Array<{
    label: 'current_session' | 'week_all_models' | 'week_sonnet';
    pct_used: number;
    resets_at_label: string;
  }>;
  contributing: Array<{ headline: string; detail: string }>;
  /**
   * Tabular breakdowns Claude shows under "What's contributing" — three
   * separate ranked lists. Each row has the entry name (which Claude
   * truncates with a unicode ellipsis to fit its TUI column, e.g.
   * `/superpowers:subagent-drive…`) and the percentage of total usage.
   * `more_count` is the integer from a trailing `… N more` line if Claude
   * decided not to render the long tail; null when fully enumerated.
   */
  skills: { rows: Array<{ name: string; pct_used: number }>; more_count: number | null };
  subagents: { rows: Array<{ name: string; pct_used: number }>; more_count: number | null };
  plugins: { rows: Array<{ name: string; pct_used: number }>; more_count: number | null };
}

export type UsageRunResult =
  | { ok: true; observed_at: number; raw: string; parsed: UsageRunData }
  | { ok: false; observed_at: number; error: string; raw?: string };

export type ValidateCliPathResult = { ok: true } | { ok: false; error: string };

export interface BranchColor {
  id: number;
  project_path: string;
  branch_name: string;
  color: string;
  sort_order: number;
  created_at: number;
}

/**
 * Represents a path prefix rule that maps directories to accounts
 */
export interface PathRule {
  id: number;
  account_id: number;
  account_name: string;
  path_prefix: string;
  priority: number;
}

/**
 * Represents an explicit project-to-account override
 */
export interface ProjectOverride {
  project_path: string;
  account_id: number;
  account_name: string;
}

/**
 * Represents a session with its metadata
 */
export interface Session {
  /** The session ID (UUID) */
  id: string;
  /** The project ID this session belongs to */
  project_id: string;
  /** The project path */
  project_path: string;
  /** Optional todo data associated with this session */
  todo_data?: any;
  /** Unix timestamp when the session file was created */
  created_at: number;
  /** First user message content (if available) */
  first_message?: string;
  /** ISO timestamp of the first JSONL entry that has a `timestamp` field. */
  first_timestamp?: string;
  /** ISO timestamp of the last JSONL entry that has a `timestamp` field. */
  last_timestamp?: string;
  /** @deprecated Filesystem mtime fallback. Prefer `last_timestamp`. */
  message_timestamp?: string;
  /** Size of the session JSONL in bytes (from fs.stat). Used by the
   *  summary refresh button to decide whether anything has changed since
   *  the last summary generation. */
  file_size_bytes?: number;
}

/**
 * Represents the settings from ~/.claude/settings.json
 */
export interface ClaudeSettings {
  [key: string]: any;
}

/**
 * Branch + working-tree status snapshot for one path (project or worktree).
 */
export interface PathSnapshot {
  path: string;
  branch: string | null;
  changed: number;
  untracked: number;
  /**
   * Latest error from `git status` / branch read for this path, or `null` if
   * the read succeeded. Surface this to the user so a wedged worktree is
   * visible rather than silently stuck at 0/0.
   */
  error: string | null;
}

/**
 * Combined per-tab git snapshot — the project and all sibling worktrees in a
 * single payload, emitted on `session-git-changed:<watchId>`.
 */
export interface SessionGitSnapshot {
  project: PathSnapshot;
  /** Sibling worktrees, sorted by path. */
  worktrees: PathSnapshot[];
}

/** Defensive normalizer for a path snapshot crossing the IPC boundary. */
function normalizePathSnapshot(data: any, fallbackPath: string): PathSnapshot {
  return {
    path: typeof data?.path === 'string' ? data.path : fallbackPath,
    branch: data?.branch ?? null,
    changed: typeof data?.changed === 'number' ? data.changed : 0,
    untracked: typeof data?.untracked === 'number' ? data.untracked : 0,
    error: typeof data?.error === 'string' ? data.error : null,
  };
}

/** A worktree attached to the same repository as the currently-open project. */
export interface WorktreeInfo {
  /** Absolute path of the worktree directory (realpath-resolved). */
  path: string;
  /** Short branch name, or null if the worktree has a detached HEAD. */
  branch: string | null;
}

/** Lima VM (parsed from `limactl list --json`). */
export interface LimaVm {
  name: string;
  status: string;
  arch: string;
  cpus: number;
  memoryBytes: number;
  diskBytes: number;
  dir: string;
}

/** Container in a Lima VM (parsed from `docker ps -a --format=json`). */
export interface LimaDockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

/**
 * Represents the Claude Code version status
 */
export interface ClaudeVersionStatus {
  /** Whether Claude Code is installed and working */
  is_installed: boolean;
  /** The version string if available */
  version?: string;
  /** The full output from the command */
  output: string;
}

/**
 * Represents a CLAUDE.md file found in the project
 */
export interface ClaudeMdFile {
  /** Relative path from the project root */
  relative_path: string;
  /** Absolute path to the file */
  absolute_path: string;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp */
  modified: number;
}

/**
 * Represents a file or directory entry
 */
export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
  extension?: string;
}

/**
 * Represents a Claude installation found on the system
 */
export interface ClaudeInstallation {
  /** Full path to the Claude binary */
  path: string;
  /** Version string if available */
  version?: string;
  /** Source of discovery (e.g., "nvm", "system", "homebrew", "which") */
  source: string;
  /** Type of installation */
  installation_type: "System" | "Custom";
}

// Usage Dashboard types
export interface UsageEntry {
  project: string;
  timestamp: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  cost: number;
}

export interface ModelUsage {
  model: string;
  total_cost: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  session_count: number;
}

export interface DailyUsage {
  date: string;
  total_cost: number;
  total_tokens: number;
  models_used: string[];
}

export interface ProjectUsage {
  project_path: string;
  project_name: string;
  total_cost: number;
  total_tokens: number;
  session_count: number;
  last_used: string;
  account_name?: string;
  account_type?: string;
}

export interface UsageStats {
  total_cost: number;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  total_sessions: number;
  by_model: ModelUsage[];
  by_date: DailyUsage[];
  by_project: ProjectUsage[];
}

export interface AccountUsageStats {
  account_name: string;
  account_type: string;
  stats: UsageStats;
}

/** Latest rate-limit snapshot for one (account, rate-limit-type) pair. */
export interface RateLimitSnapshot {
  account_name: string;
  /** 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage' */
  rate_limit_type: string;
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** 0–100. May be null when the SDK didn't include it. */
  utilization: number | null;
  /** Unix epoch seconds. May be null. */
  resets_at: number | null;
  /** Unix epoch ms — when GreyChrist saw this snapshot. */
  observed_at: number;
}

/** User-configurable rate-limit settings. */
export interface RateLimitSettings {
  notifications_enabled: boolean;
  five_hour_thresholds_pct: number[];
  seven_day_notifications_enabled: boolean;
  seven_day_thresholds_pct: number[];
  sound_enabled: boolean;
}

/**
 * Represents an MCP server configuration
 */
export interface MCPServer {
  /** Server name/identifier */
  name: string;
  /** Transport type: "stdio" or "sse" */
  transport: string;
  /** Command to execute (for stdio) */
  command?: string;
  /** Command arguments (for stdio) */
  args: string[];
  /** Environment variables */
  env: Record<string, string>;
  /** URL endpoint (for SSE) */
  url?: string;
  /** Configuration scope: "local", "project", or "user" */
  scope: string;
  /** Whether the server is currently active */
  is_active: boolean;
  /** Server status */
  status: ServerStatus;
}

/**
 * Server status information
 */
export interface ServerStatus {
  /** Whether the server is running */
  running: boolean;
  /** Last error message if any */
  error?: string;
  /** Last checked timestamp */
  last_checked?: number;
}

/**
 * Live MCP server status from the SDK during an active session.
 */
export interface SessionMcpServerStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: { name: string; version: string };
  error?: string;
  config?: Record<string, unknown>;
  scope?: string;
  tools?: { name: string; description?: string }[];
}

/**
 * Loaded plugin in an active session, enriched with .claude-plugin/plugin.json
 * manifest fields when available.
 */
export interface SessionPluginInfo {
  name: string;
  path: string;
  source?: string;
  scope: 'user' | 'project' | 'local' | 'unknown';
  version?: string;
  description?: string;
  author?: string;
  authorEmail?: string;
}

/**
 * MCP configuration for project scope (.mcp.json)
 */
export interface MCPProjectConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

/**
 * Individual server configuration in .mcp.json
 */
export interface MCPServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Represents a custom slash command
 */
export interface SlashCommand {
  /** Unique identifier for the command */
  id: string;
  /** Command name (without prefix) */
  name: string;
  /** Full command with prefix (e.g., "/project:optimize") */
  full_command: string;
  /** Command scope: "project" or "user" */
  scope: string;
  /** Optional namespace (e.g., "frontend" in "/project:frontend:component") */
  namespace?: string;
  /** Path to the markdown file */
  file_path: string;
  /** Command content (markdown body) */
  content: string;
  /** Optional description from frontmatter */
  description?: string;
  /** Allowed tools from frontmatter */
  allowed_tools: string[];
  /** Whether the command has bash commands (!) */
  has_bash_commands: boolean;
  /** Whether the command has file references (@) */
  has_file_references: boolean;
  /** Whether the command uses $ARGUMENTS placeholder */
  accepts_arguments: boolean;
}

/**
 * Result of adding a server
 */
export interface AddServerResult {
  success: boolean;
  message: string;
  server_name?: string;
}

/**
 * Import result for multiple servers
 */
export interface ImportResult {
  imported_count: number;
  failed_count: number;
  servers: ImportServerResult[];
}

/**
 * Result for individual server import
 */
export interface ImportServerResult {
  name: string;
  success: boolean;
  error?: string;
}

export interface LogEntry {
  id?: number;
  timestamp: string;
  level: string;
  source: string;
  category?: string;
  message: string;
  metadata?: string;
}

export interface LogQueryFilters {
  /** Any of these log levels (OR-joined). Omit to match all levels. */
  levels?: string[];
  /** Any of these sources (OR-joined). Omit to match all sources. */
  sources?: string[];
  /** Case-insensitive LIKE match on message. */
  search?: string;
  /** ISO timestamp lower bound (inclusive). */
  since?: string;
  /** ISO timestamp upper bound (inclusive). */
  until?: string;
  limit: number;
  offset: number;
}

/** Filters accepted by logCount(). Same shape as LogQueryFilters but limit/offset are meaningless. */
export interface LogCountFilters {
  levels?: string[];
  sources?: string[];
  search?: string;
  since?: string;
  until?: string;
}

export interface LogQueryResult {
  entries: LogEntry[];
  total: number;
}

// Wave 2 — SDK Query-method return shapes (mirrored from
// @anthropic-ai/claude-agent-sdk so the renderer doesn't have to import
// the SDK types directly). Kept loose so minor SDK additions don't break
// the frontend.

export interface SessionAccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'mantle';
}

export interface SessionContextUsageCategory {
  name: string;
  tokens: number;
  color: string;
  isDeferred?: boolean;
}

export interface SessionContextUsage {
  categories: SessionContextUsageCategory[];
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
}

/**
 * Per-tab status summary the renderer publishes up to main. Both the status
 * popover and the install-gate read from the aggregated list. The renderer
 * is the canonical interpreter — it knows messages, subagents, and todos —
 * so main treats this as opaque pass-through with a few well-known fields.
 */
export interface TabStatusTodos {
  total: number;
  completed: number;
  inFlight: boolean;
}

export interface TabStatusSummary {
  tabId: string;
  title: string;
  projectPath: string | null;
  /** True iff a persistent SDK session is alive for this tab. */
  sessionStarted: boolean;
  /** Roll-up: mainTurnInFlight || activeAgents > 0 || todos.inFlight. */
  busy: boolean;
  mainTurnInFlight: boolean;
  /** Running, un-dismissed subagents (Agent / Task / run_in_background:Bash). */
  activeAgents: number;
  todos: TabStatusTodos;
  contextUsage: {
    totalTokens: number;
    maxTokens: number;
    percentage: number;
  } | null;
  branch: string | null;
  filesChanged: number;
  filesUntracked: number;
  /** High-level status for the badge in the popover. */
  status: 'not-started' | 'starting' | 'idle' | 'busy' | 'error';
  /**
   * Set when the session is paused waiting on the user — a permission grant
   * or an AskUserQuestion answer. The TabStatusPopover overrides the badge
   * label/color when this is non-null so background tabs that need the user
   * are obvious at a glance. Null when nothing is waiting.
   */
  waitingFor: 'permission' | 'question' | null;
  /** Wall-clock ms when this summary was published. */
  updatedAt: number;
}

export interface SessionSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

// Sidecar mirror — keep in sync with electron/services/sessions-summary.ts.
export interface SessionSummary {
  version: number;
  headline: string;
  paragraph: string;
  messageCount: number;
  jsonlSize: number;
  generatedAt: string;
  model: string;
  accountName: string;
  truncated?: boolean;
  /** FNV-1a hash of the prompt template that produced this summary.
   *  A mismatch with the current prompt's hash invalidates the size-
   *  change gate so a refresh click regenerates with the new prompt. */
  promptHash?: string;
  /** @deprecated older sidecars used a numeric version; kept for read-back only. */
  promptVersion?: number;
}

/** app_settings key under which the user-editable prompt template is
 *  stored. Mirrors the backend constant in sessions-summary.ts. */
export const PROMPT_TEMPLATE_SETTING_KEY = 'sessionsSummary.promptTemplate';

/** app_settings key for the master "summaries on/off" toggle. When
 *  off, sessions list rows show first_message instead of any cached
 *  sidecar, the manual refresh button is hidden, and the auto-on-close
 *  lifecycle hook also bails (it gates on enabled AND autoOnClose).
 *  Mirrors the backend constant in sessions-summary.ts. Stored as
 *  `'true'` or `'false'`. */
export const ENABLED_SETTING_KEY = 'sessionsSummary.enabled';

/** app_settings key for the "auto-summarize on session close" toggle.
 *  Only gates the lifecycle hook — the manual refresh button is
 *  unaffected. Mirrors the backend constant in sessions-summary.ts.
 *  Stored as `'true'` or `'false'`. */
export const AUTO_ON_CLOSE_SETTING_KEY = 'sessionsSummary.autoOnClose';

/**
 * Discriminated result of `summaryGenerate`. Mirrors
 * `SummaryGenerateResult` in electron/services/sessions-summary.ts.
 *
 * The renderer uses the tag to differentiate "succeeded but no change",
 * "skipped because the account isn't configured", "model returned
 * gibberish", etc. — so the manual refresh button can give honest
 * feedback instead of silently failing.
 */
export type SummaryGenerateResult =
  | { status: 'generated'; summary: SessionSummary }
  | { status: 'unchanged'; summary: SessionSummary }
  | {
      status: 'skipped';
      reason: 'no-account' | 'toggle-off' | 'no-model' | 'empty-session' | 'jsonl-missing' | 'jsonl-unreadable';
    }
  | { status: 'malformed-response' };

export interface SessionModelInfo {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[];
}

/**
 * API client for interacting with the Rust backend
 */
export const api = {
  /**
   * Gets the user's home directory path
   * @returns Promise resolving to the home directory path
   */
  async getHomeDirectory(): Promise<string> {
    try {
      return await apiCall<string>("get_home_directory");
    } catch (error) {
      console.error("Failed to get home directory:", error);
      return "/";
    }
  },

  /**
   * Lists all projects in the ~/.claude/projects directory
   * @returns Promise resolving to an array of projects
   */
  async listProjects(): Promise<Project[]> {
    try {
      return await apiCall<Project[]>("list_projects");
    } catch (error) {
      console.error("Failed to list projects:", error);
      throw error;
    }
  },

  /**
   * Creates a new project for the given directory path
   * @param path - The directory path to create a project for
   * @returns Promise resolving to the created project
   */
  async createProject(path: string): Promise<Project> {
    try {
      return await apiCall<Project>('create_project', { path });
    } catch (error) {
      console.error("Failed to create project:", error);
      throw error;
    }
  },

  /**
   * Retrieves sessions for a specific project
   * @param projectId - The ID of the project to retrieve sessions for
   * @returns Promise resolving to an array of sessions
   */
  async getProjectSessions(projectId: string, projectPath?: string): Promise<Session[]> {
    try {
      const params: Record<string, string> = { projectId };
      if (projectPath) params.projectPath = projectPath;
      return await apiCall<Session[]>('get_project_sessions', params);
    } catch (error) {
      console.error("Failed to get project sessions:", error);
      throw error;
    }
  },

  /**
   * Permanently delete a session — its JSONL file and any ride-along
   * sidecars (`*.summary.json`, `*.todo.json`). Throws when the session
   * file isn't found or the project's config dir can't be resolved;
   * the caller should catch and surface a toast/inline error.
   */
  async deleteSession(
    sessionId: string,
    projectId: string,
    projectPath?: string,
  ): Promise<void> {
    const params: Record<string, string> = { sessionId, projectId };
    if (projectPath) params.projectPath = projectPath;
    await apiCall<unknown>('delete_session', params);
  },

  /**
   * Reads the Claude settings file
   * @returns Promise resolving to the settings object
   */
  async getClaudeSettings(opts?: { projectPath?: string; configDir?: string }): Promise<ClaudeSettings> {
    try {
      const params: Record<string, unknown> = {};
      if (opts?.projectPath !== undefined) params.projectPath = opts.projectPath;
      if (opts?.configDir !== undefined) params.configDir = opts.configDir;
      const result = await apiCall<{ data: ClaudeSettings }>("get_claude_settings", params);

      // The Rust backend returns ClaudeSettings { data: ... }
      // We need to extract the data field
      if (result && typeof result === 'object' && 'data' in result) {
        return result.data;
      }

      // If the result is already the settings object, return it
      return result as ClaudeSettings;
    } catch (error) {
      console.error("Failed to get Claude settings:", error);
      throw error;
    }
  },

  /**
   * Opens a new Claude Code session
   * @param path - Optional path to open the session in
   * @returns Promise resolving when the session is opened
   */
  async openNewSession(path?: string): Promise<string> {
    try {
      return await apiCall<string>("open_new_session", { path });
    } catch (error) {
      console.error("Failed to open new session:", error);
      throw error;
    }
  },

  /**
   * Reads the CLAUDE.md system prompt file
   * @returns Promise resolving to the system prompt content
   */
  async getSystemPrompt(): Promise<string> {
    try {
      return await apiCall<string>("get_system_prompt");
    } catch (error) {
      console.error("Failed to get system prompt:", error);
      throw error;
    }
  },

  /**
   * Checks if Claude Code is installed and gets its version
   * @returns Promise resolving to the version status
   */
  async checkClaudeVersion(): Promise<ClaudeVersionStatus> {
    try {
      return await apiCall<ClaudeVersionStatus>("check_claude_version");
    } catch (error) {
      console.error("Failed to check Claude version:", error);
      throw error;
    }
  },

  /**
   * Saves the CLAUDE.md system prompt file
   * @param content - The new content for the system prompt
   * @returns Promise resolving when the file is saved
   */
  async saveSystemPrompt(content: string): Promise<string> {
    try {
      return await apiCall<string>("save_system_prompt", { content });
    } catch (error) {
      console.error("Failed to save system prompt:", error);
      throw error;
    }
  },

  /**
   * Saves the Claude settings file
   * @param settings - The settings object to save
   * @returns Promise resolving when the settings are saved
   */
  async saveClaudeSettings(settings: ClaudeSettings, opts?: { projectPath?: string; configDir?: string }): Promise<string> {
    try {
      const params: Record<string, unknown> = { settings };
      if (opts?.projectPath !== undefined) params.projectPath = opts.projectPath;
      if (opts?.configDir !== undefined) params.configDir = opts.configDir;
      return await apiCall<string>("save_claude_settings", params);
    } catch (error) {
      console.error("Failed to save Claude settings:", error);
      throw error;
    }
  },

  /**
   * Finds all CLAUDE.md files in a project directory
   * @param projectPath - The absolute path to the project
   * @returns Promise resolving to an array of CLAUDE.md files
   */
  async findClaudeMdFiles(projectPath: string): Promise<ClaudeMdFile[]> {
    try {
      return await apiCall<ClaudeMdFile[]>("find_claude_md_files", { projectPath });
    } catch (error) {
      console.error("Failed to find CLAUDE.md files:", error);
      throw error;
    }
  },

  /**
   * Reads a specific CLAUDE.md file
   * @param filePath - The absolute path to the file
   * @returns Promise resolving to the file content
   */
  async readClaudeMdFile(filePath: string): Promise<string> {
    try {
      return await apiCall<string>("read_claude_md_file", { filePath });
    } catch (error) {
      console.error("Failed to read CLAUDE.md file:", error);
      throw error;
    }
  },

  /**
   * Saves a specific CLAUDE.md file
   * @param filePath - The absolute path to the file
   * @param content - The new content for the file
   * @returns Promise resolving when the file is saved
   */
  async saveClaudeMdFile(filePath: string, content: string): Promise<string> {
    try {
      return await apiCall<string>("save_claude_md_file", { filePath, content });
    } catch (error) {
      console.error("Failed to save CLAUDE.md file:", error);
      throw error;
    }
  },


  /**
   * Reveals a path in the system file manager (Finder on macOS).
   */
  async revealPathInFinder(path: string): Promise<void> {
    try {
      await apiCall<void>('reveal_path_in_finder', { path });
    } catch (error) {
      console.error("Failed to reveal path:", error);
      throw error;
    }
  },

  /**
   * Loads a session's JSONL transcript from disk.
   */
  async loadSessionHistory(sessionId: string, projectId: string, projectPath?: string): Promise<any[]> {
    const params: Record<string, string> = { sessionId, projectId };
    if (projectPath) params.projectPath = projectPath;
    return apiCall("load_session_history", params);
  },

  /**
   * Executes a new interactive Claude Code session with streaming output
   */
  async executeClaudeCode(projectPath: string, prompt: string, model: string, skipPermissions?: boolean): Promise<void> {
    return apiCall("execute_claude_code", { projectPath, prompt, model, skipPermissions });
  },

  /**
   * Continues an existing Claude Code conversation with streaming output
   */
  async continueClaudeCode(projectPath: string, prompt: string, model: string, skipPermissions?: boolean): Promise<void> {
    return apiCall("continue_claude_code", { projectPath, prompt, model, skipPermissions });
  },

  /**
   * Resumes an existing Claude Code session by ID with streaming output
   */
  async resumeClaudeCode(projectPath: string, sessionId: string, prompt: string, model: string, skipPermissions?: boolean): Promise<void> {
    return apiCall("resume_claude_code", { projectPath, sessionId, prompt, model, skipPermissions });
  },

  /**
   * Cancels the currently running Claude Code execution
   * @param sessionId - Optional session ID to cancel a specific session
   */
  async cancelClaudeExecution(sessionId?: string): Promise<void> {
    return apiCall("cancel_claude_execution", { sessionId });
  },

  /**
   * Send input to a running Claude Code session via stdin
   */
  async sendSessionInput(sessionId: string, input: string): Promise<void> {
    return apiCall("send_session_input", { sessionId, input });
  },

  // ─── Persistent Session API ───────────────────────────────────────

  async startSession(tabId: string, projectPath: string, model: string, permissionMode: string, resumeSessionId?: string, configDir?: string, effort?: string, thinking?: Record<string, unknown>): Promise<void> {
    return apiCall("session_start", { tabId, projectPath, model, permissionMode, resumeSessionId, configDir, effort, thinking });
  },

  /**
   * Re-claim ownership of an in-flight session for this window without
   * restarting it. Returns true if the main process had a live session for
   * this tabId (and rebound event routing to this window), false otherwise.
   * Use after a renderer reload (Cmd+R) to avoid tearing down a healthy SDK
   * query and replacing it with a fresh resume.
   */
  async sessionRebind(tabId: string): Promise<boolean> {
    return apiCall("session_rebind", { tabId });
  },

  async sendMessage(tabId: string, prompt: string): Promise<void> {
    return apiCall("session_send_message", { tabId, prompt });
  },

  async sendStructuredMessage(tabId: string, content: Array<Record<string, unknown>>): Promise<void> {
    return apiCall("session_send_structured_message", { tabId, content });
  },

  async respondPermission(tabId: string, requestId: string, behavior: string, updatedInput?: any, updatedPermissions?: any[]): Promise<void> {
    return apiCall("session_respond_permission", { tabId, requestId, behavior, updatedInput, updatedPermissions });
  },

  async respondElicitation(tabId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>): Promise<void> {
    return apiCall("session_respond_elicitation", { tabId, action, content });
  },

  async stopSession(tabId: string): Promise<void> {
    return apiCall("session_stop", { tabId });
  },

  async getSessionInfo(tabId: string): Promise<any | null> {
    return apiCall("session_get_info", { tabId });
  },

  async sessionGetHealth(tabId: string): Promise<{ alive: boolean; status: string; sessionId: string | null }> {
    return apiCall("session_get_health", { tabId });
  },

  // ─── Wave 2: Query-method passthroughs ──────────────────────────

  /** Interrupt the current assistant turn without ending the session. */
  async sessionInterrupt(tabId: string): Promise<void> {
    return apiCall("session_interrupt", { tabId });
  },

  /** Switch the model used for subsequent turns in an active session. */
  async sessionSetModel(tabId: string, model?: string): Promise<void> {
    return apiCall("session_set_model", { tabId, model });
  },

  /** Switch permission mode mid-session. */
  async sessionSetPermissionMode(tabId: string, mode: string): Promise<void> {
    return apiCall("session_set_permission_mode", { tabId, mode });
  },

  /** Change the effort level for subsequent turns in an active session. */
  async sessionSetEffort(tabId: string, level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null): Promise<void> {
    return apiCall("session_set_effort", { tabId, level });
  },

  /** Change the thinking configuration for subsequent turns in an active session. */
  async sessionSetThinking(tabId: string, config: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' } | null): Promise<void> {
    return apiCall("session_set_thinking", { tabId, config });
  },

  /** Get the SDK-reported authenticated account for an active session. */
  async sessionAccountInfo(tabId: string): Promise<SessionAccountInfo | null> {
    return apiCall("session_account_info", { tabId });
  },

  /** Get the current context-window usage for an active session. */
  async sessionContextUsage(tabId: string): Promise<SessionContextUsage | null> {
    return apiCall("session_context_usage", { tabId });
  },

  /** Get the list of slash commands the SDK knows about for this session. */
  async sessionSupportedCommands(tabId: string): Promise<SessionSlashCommand[]> {
    return apiCall("session_supported_commands", { tabId });
  },

  /** Get the list of models the SDK knows about for this session. */
  async sessionSupportedModels(tabId: string): Promise<SessionModelInfo[]> {
    return apiCall("session_supported_models", { tabId });
  },

  /**
   * Get the SDK's model catalog for a given account without starting a session.
   * Spins up an ephemeral query() scoped to `configDir` just long enough to
   * read the init handshake.
   */
  async listSupportedModels(configDir: string): Promise<SessionModelInfo[]> {
    return apiCall("list_supported_models", { configDir });
  },

  async sessionMcpServerStatus(tabId: string): Promise<SessionMcpServerStatus[]> {
    return apiCall("session_mcp_server_status", { tabId });
  },

  async sessionPlugins(tabId: string, force = false): Promise<SessionPluginInfo[]> {
    return apiCall("session_plugins", { tabId, force });
  },

  async sessionGetPermissions(tabId: string, projectPath: string, configDir: string): Promise<any[]> {
    return apiCall("session_get_permissions", { tabId, projectPath, configDir });
  },

  /** Switch the session between SDK mode and TUI mode. */
  async setSessionMode(tabId: string, mode: 'sdk' | 'tui'): Promise<void> {
    return apiCall('session_set_mode', { tabId, mode });
  },

  /** Write raw bytes to the TUI pty (only valid in TUI mode). */
  async tuiWrite(tabId: string, data: string): Promise<void> {
    return apiCall('session_tui_write', { tabId, data });
  },

  /** Notify the TUI pty of a terminal resize. */
  async tuiResize(tabId: string, cols: number, rows: number): Promise<void> {
    return apiCall('session_tui_resize', { tabId, cols, rows });
  },

  async sessionUpdatePermission(tabId: string, projectPath: string, configDir: string, update: {
    action: "add" | "remove";
    scope: string;
    behavior: "allow" | "deny";
    rule: string;
  }): Promise<void> {
    return apiCall("session_update_permission", { tabId, projectPath, configDir, ...update });
  },

  // ─── Logging API ────────────────────────────────────────────────

  async logWriteBatch(entries: LogEntry[]): Promise<void> {
    return apiCall("log_write_batch", { entries });
  },

  async logQuery(filters: LogQueryFilters): Promise<LogQueryResult> {
    return apiCall("log_query", {
      levels: filters.levels,
      sources: filters.sources,
      search: filters.search,
      since: filters.since,
      until: filters.until,
      limit: filters.limit,
      offset: filters.offset,
    });
  },

  async logPrune(olderThan?: string): Promise<number> {
    return apiCall("log_prune", { olderThan });
  },

  async logCount(filters?: LogCountFilters): Promise<number> {
    return apiCall("log_count", {
      levels: filters?.levels,
      sources: filters?.sources,
      search: filters?.search,
      since: filters?.since,
      until: filters?.until,
    });
  },

  /**
   * Gets live output from a Claude session
   * @param sessionId - The session ID to get output for
   * @returns Promise resolving to the current live output
   */
  async getClaudeSessionOutput(sessionId: string): Promise<string> {
    return apiCall("get_claude_session_output", { sessionId });
  },

  /**
   * Lists files and directories in a given path
   */
  async listDirectoryContents(directoryPath: string): Promise<FileEntry[]> {
    return apiCall("list_directory_contents", { directoryPath });
  },

  /**
   * Searches for files and directories matching a pattern
   */
  async searchFiles(basePath: string, query: string): Promise<FileEntry[]> {
    return apiCall("search_files", { basePath, query });
  },

  /**
   * Gets overall usage statistics
   * @returns Promise resolving to usage statistics
   */
  async getUsageStats(): Promise<UsageStats> {
    try {
      return await apiCall<UsageStats>("get_usage_stats");
    } catch (error) {
      console.error("Failed to get usage stats:", error);
      throw error;
    }
  },

  /**
   * Gets usage statistics filtered by date range
   * @param startDate - Start date (ISO format)
   * @param endDate - End date (ISO format)
   * @returns Promise resolving to usage statistics
   */
  async getUsageByDateRange(startDate: string, endDate: string): Promise<UsageStats> {
    try {
      return await apiCall<UsageStats>("get_usage_by_date_range", { startDate, endDate });
    } catch (error) {
      console.error("Failed to get usage by date range:", error);
      throw error;
    }
  },

  /**
   * Gets usage statistics grouped by session
   * @param since - Optional start date (YYYYMMDD)
   * @param until - Optional end date (YYYYMMDD)
   * @param order - Optional sort order ('asc' or 'desc')
   * @returns Promise resolving to an array of session usage data
   */
  async getSessionStats(
    since?: string,
    until?: string,
    order?: "asc" | "desc"
  ): Promise<ProjectUsage[]> {
    try {
      return await apiCall<ProjectUsage[]>("get_session_stats", {
        since,
        until,
        order,
      });
    } catch (error) {
      console.error("Failed to get session stats:", error);
      throw error;
    }
  },

  /**
   * Gets detailed usage entries with optional filtering
   * @param limit - Optional limit for number of entries
   * @returns Promise resolving to array of usage entries
   */
  async getUsageDetails(limit?: number): Promise<UsageEntry[]> {
    try {
      return await apiCall<UsageEntry[]>("get_usage_details", { limit });
    } catch (error) {
      console.error("Failed to get usage details:", error);
      throw error;
    }
  },

  async getUsageByAccount(startDate?: string, endDate?: string): Promise<AccountUsageStats[]> {
    return apiCall("get_usage_by_account", {
      start_date: startDate,
      end_date: endDate,
    });
  },

  /** Run /usage via the CLI for a specific account. Max accounts only. */
  async getCliUsage(configDir?: string): Promise<string> {
    return apiCall("get_cli_usage", { configDir });
  },

  /** Latest rate-limit snapshots across all accounts (or one if accountName given). */
  async getRateLimits(accountName?: string): Promise<RateLimitSnapshot[]> {
    return apiCall<RateLimitSnapshot[]>("get_rate_limits", { accountName });
  },

  /** Read user's rate-limit notification settings. */
  async getRateLimitSettings(): Promise<RateLimitSettings> {
    return apiCall<RateLimitSettings>("get_rate_limit_settings");
  },

  /** Update one or more rate-limit notification settings; returns the merged result. */
  async updateRateLimitSettings(
    partial: Partial<RateLimitSettings>,
  ): Promise<RateLimitSettings> {
    return apiCall<RateLimitSettings>("update_rate_limit_settings", partial as Record<string, unknown>);
  },

  /**
   * Run `/usage` via a PTY in the main process and return the parsed result.
   * Also feeds the per-window utilization into the rate-limits snapshot store
   * so the existing widgets pick up the fresh data without further wiring.
   */
  async runUsageCli(accountName: string): Promise<UsageRunResult> {
    return apiCall<UsageRunResult>("usage_run_cli", { accountName });
  },

  /** Read the last cached `/usage` result for an account, if any. */
  async getLastUsageCli(accountName: string): Promise<UsageRunResult | null> {
    return apiCall<UsageRunResult | null>("usage_get_last", { accountName });
  },

  /** Validate a per-account CLI path (path must point to an executable file, or be empty). */
  async validateCliPath(path: string | null): Promise<ValidateCliPathResult> {
    return apiCall<ValidateCliPathResult>("accounts_validate_cli_path", { path });
  },

  /**
   * Adds a new MCP server
   */
  async mcpAdd(
    name: string,
    transport: string,
    command?: string,
    args: string[] = [],
    env: Record<string, string> = {},
    url?: string,
    scope: string = "local",
    configDir?: string
  ): Promise<AddServerResult> {
    try {
      return await apiCall<AddServerResult>("mcp_add", {
        name,
        transport,
        command,
        args,
        env,
        url,
        scope,
        configDir
      });
    } catch (error) {
      console.error("Failed to add MCP server:", error);
      throw error;
    }
  },

  /**
   * Lists all configured MCP servers
   */
  async mcpList(configDir?: string): Promise<MCPServer[]> {
    try {
      const result = await apiCall<MCPServer[]>("mcp_list", { configDir });
      return result;
    } catch (error) {
      console.error("API: Failed to list MCP servers:", error);
      throw error;
    }
  },

  /**
   * Gets details for a specific MCP server
   */
  async mcpGet(name: string, configDir?: string): Promise<MCPServer> {
    try {
      return await apiCall<MCPServer>("mcp_get", { name, configDir });
    } catch (error) {
      console.error("Failed to get MCP server:", error);
      throw error;
    }
  },

  /**
   * Removes an MCP server
   */
  async mcpRemove(name: string, configDir?: string): Promise<string> {
    try {
      return await apiCall<string>("mcp_remove", { name, configDir });
    } catch (error) {
      console.error("Failed to remove MCP server:", error);
      throw error;
    }
  },

  /**
   * Adds an MCP server from JSON configuration
   */
  async mcpAddJson(name: string, jsonConfig: string, scope: string = "local", configDir?: string): Promise<AddServerResult> {
    try {
      return await apiCall<AddServerResult>("mcp_add_json", { name, jsonConfig, scope, configDir });
    } catch (error) {
      console.error("Failed to add MCP server from JSON:", error);
      throw error;
    }
  },

  /**
   * Imports MCP servers from Claude Desktop
   */
  async mcpAddFromClaudeDesktop(scope: string = "local", configDir?: string): Promise<ImportResult> {
    try {
      return await apiCall<ImportResult>("mcp_add_from_claude_desktop", { scope, configDir });
    } catch (error) {
      console.error("Failed to import from Claude Desktop:", error);
      throw error;
    }
  },

  /**
   * Starts Claude Code as an MCP server
   */
  async mcpServe(): Promise<string> {
    try {
      return await apiCall<string>("mcp_serve");
    } catch (error) {
      console.error("Failed to start MCP server:", error);
      throw error;
    }
  },

  /**
   * Tests connection to an MCP server
   */
  async mcpTestConnection(name: string, configDir?: string): Promise<string> {
    try {
      return await apiCall<string>("mcp_test_connection", { name, configDir });
    } catch (error) {
      console.error("Failed to test MCP connection:", error);
      throw error;
    }
  },

  /**
   * Resets project-scoped server approval choices
   */
  async mcpResetProjectChoices(): Promise<string> {
    try {
      return await apiCall<string>("mcp_reset_project_choices");
    } catch (error) {
      console.error("Failed to reset project choices:", error);
      throw error;
    }
  },

  /**
   * Gets the status of MCP servers
   */
  async mcpGetServerStatus(configDir?: string): Promise<Record<string, ServerStatus>> {
    try {
      return await apiCall<Record<string, ServerStatus>>("mcp_get_server_status", { configDir });
    } catch (error) {
      console.error("Failed to get server status:", error);
      throw error;
    }
  },

  /**
   * Reads .mcp.json from the current project
   */
  async mcpReadProjectConfig(projectPath: string): Promise<MCPProjectConfig> {
    try {
      return await apiCall<MCPProjectConfig>("mcp_read_project_config", { projectPath });
    } catch (error) {
      console.error("Failed to read project MCP config:", error);
      throw error;
    }
  },

  /**
   * Saves .mcp.json to the current project
   */
  async mcpSaveProjectConfig(projectPath: string, config: MCPProjectConfig): Promise<string> {
    try {
      return await apiCall<string>("mcp_save_project_config", { projectPath, config });
    } catch (error) {
      console.error("Failed to save project MCP config:", error);
      throw error;
    }
  },

  /**
   * Get the stored Claude binary path from settings
   * @returns Promise resolving to the path if set, null otherwise
   */
  async getClaudeBinaryPath(): Promise<string | null> {
    try {
      return await apiCall<string | null>("get_claude_binary_path");
    } catch (error) {
      console.error("Failed to get Claude binary path:", error);
      throw error;
    }
  },

  /**
   * Set the Claude binary path in settings
   * @param path - The absolute path to the Claude binary
   * @returns Promise resolving when the path is saved
   */
  async setClaudeBinaryPath(path: string): Promise<void> {
    try {
      return await apiCall<void>("set_claude_binary_path", { path });
    } catch (error) {
      console.error("Failed to set Claude binary path:", error);
      throw error;
    }
  },

  /**
   * List all available Claude installations on the system
   * @returns Promise resolving to an array of Claude installations
   */
  async listClaudeInstallations(): Promise<ClaudeInstallation[]> {
    try {
      return await apiCall<ClaudeInstallation[]>("list_claude_installations");
    } catch (error) {
      console.error("Failed to list Claude installations:", error);
      throw error;
    }
  },

  // ── Git ──────────────────────────────────────────────────────────────────

  /**
   * Get the current git branch for a project path.
   * @param projectPath - The project directory to check
   * @returns Promise resolving to the branch name or null if not a git repo
   */
  async getGitBranch(projectPath: string): Promise<string | null> {
    return apiCall("get_git_branch", { projectPath });
  },

  /**
   * List worktrees attached to the same repository as `projectPath`,
   * excluding `projectPath` itself. Returns [] for non-git directories.
   */
  async listGitWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
    const result = await apiCall<WorktreeInfo[]>("list_git_worktrees", { projectPath });
    return result ?? [];
  },

  /**
   * Start a single per-tab git watch covering both the project itself and any
   * sibling worktrees. The returned snapshot is the initial state; further
   * updates stream over `session-git-changed:<watchId>`.
   */
  async startSessionGitWatch(projectPath: string): Promise<{
    watchId: string;
    snapshot: SessionGitSnapshot;
  } | null> {
    return apiCall("start_session_git_watch", { projectPath });
  },

  /** Stop a per-tab session git watch. */
  async stopSessionGitWatch(watchId: string): Promise<void> {
    await apiCall("stop_session_git_watch", { watchId });
  },

  /**
   * Tear down + recreate the watch's internal fs.watch handles and force a
   * fresh refresh cycle (re-list peers, re-read every path). Returns the
   * latest snapshot, or null if the watchId is unknown.
   */
  async reconnectSessionGitWatch(watchId: string): Promise<SessionGitSnapshot | null> {
    return apiCall("reconnect_session_git_watch", { watchId });
  },

  /**
   * Subscribe to session-git updates for a watch. The callback fires with the
   * full snapshot whenever anything visible (project status, peer add/remove,
   * peer status, error) changes. Returns an unsubscribe function.
   */
  onSessionGitChanged(
    watchId: string,
    callback: (snapshot: SessionGitSnapshot) => void,
  ): () => void {
    return window.electronAPI.onEvent(
      `session-git-changed:${watchId}`,
      (data: any) => {
        if (!data || typeof data !== 'object') return;
        const project = normalizePathSnapshot(data.project, '');
        const worktrees = Array.isArray(data.worktrees)
          ? data.worktrees.map((w: any) => normalizePathSnapshot(w, ''))
          : [];
        callback({ project, worktrees });
      },
    );
  },

  // ── Lima (VM viewer) ──────────────────────────────────────────────────────

  /** Check whether `limactl` is on the user's PATH. */
  async limaCheckInstalled(): Promise<{ installed: boolean }> {
    return apiCall("lima_check_installed");
  },

  /** List all Lima VMs (running and stopped). */
  async limaListVms(): Promise<LimaVm[]> {
    const result = await apiCall<LimaVm[]>("lima_list_vms");
    return result ?? [];
  },

  /** List Docker containers inside a running Lima VM. Returns [] if the VM
   *  is stopped or doesn't have docker installed. */
  async limaListContainers(vmName: string): Promise<LimaDockerContainer[]> {
    const result = await apiCall<LimaDockerContainer[]>("lima_list_containers", { vmName });
    return result ?? [];
  },

  /** Start a stopped Lima VM. Resolves when the VM reports ready. */
  async limaStartVm(vmName: string): Promise<void> {
    await apiCall("lima_start_vm", { vmName });
  },

  /** Stop a running Lima VM. Resolves when the VM has fully shut down. */
  async limaStopVm(vmName: string): Promise<void> {
    await apiCall("lima_stop_vm", { vmName });
  },

  /** Non-destructively start a Docker container in a Lima VM (`docker start`).
   *  Preserves volumes, env, and named state — does not recreate. */
  async limaStartContainer(vmName: string, containerId: string): Promise<void> {
    await apiCall("lima_start_container", { vmName, containerId });
  },

  /** Non-destructively stop a Docker container in a Lima VM (`docker stop`). */
  async limaStopContainer(vmName: string, containerId: string): Promise<void> {
    await apiCall("lima_stop_container", { vmName, containerId });
  },

  /**
   * The SDK version the current build is compiled against (installed in
   * node_modules). Returns null if it cannot be resolved.
   */
  async getReferencedSdkVersion(): Promise<string | null> {
    return apiCall("get_referenced_sdk_version");
  },

  /**
   * The latest published SDK version on the npm registry. Returns null on
   * network failure or parse error.
   */
  async getLatestSdkVersion(): Promise<string | null> {
    return apiCall("get_latest_sdk_version");
  },

  // Storage API methods

  /**
   * Lists all tables in the SQLite database
   * @returns Promise resolving to an array of table information
   */
  async storageListTables(): Promise<any[]> {
    try {
      return await apiCall<any[]>("storage_list_tables");
    } catch (error) {
      console.error("Failed to list tables:", error);
      throw error;
    }
  },

  /**
   * Reads table data with pagination
   * @param tableName - Name of the table to read
   * @param page - Page number (1-indexed)
   * @param pageSize - Number of rows per page
   * @param searchQuery - Optional search query
   * @returns Promise resolving to table data with pagination info
   */
  async storageReadTable(
    tableName: string,
    page: number,
    pageSize: number,
    searchQuery?: string
  ): Promise<any> {
    try {
      return await apiCall<any>("storage_read_table", {
        tableName,
        page,
        pageSize,
        searchQuery,
      });
    } catch (error) {
      console.error("Failed to read table:", error);
      throw error;
    }
  },

  /**
   * Updates a row in a table
   * @param tableName - Name of the table
   * @param primaryKeyValues - Map of primary key column names to values
   * @param updates - Map of column names to new values
   * @returns Promise resolving when the row is updated
   */
  async storageUpdateRow(
    tableName: string,
    primaryKeyValues: Record<string, any>,
    updates: Record<string, any>
  ): Promise<void> {
    try {
      return await apiCall<void>("storage_update_row", {
        tableName,
        primaryKeyValues,
        updates,
      });
    } catch (error) {
      console.error("Failed to update row:", error);
      throw error;
    }
  },

  /**
   * Deletes a row from a table
   * @param tableName - Name of the table
   * @param primaryKeyValues - Map of primary key column names to values
   * @returns Promise resolving when the row is deleted
   */
  async storageDeleteRow(
    tableName: string,
    primaryKeyValues: Record<string, any>
  ): Promise<void> {
    try {
      return await apiCall<void>("storage_delete_row", {
        tableName,
        primaryKeyValues,
      });
    } catch (error) {
      console.error("Failed to delete row:", error);
      throw error;
    }
  },

  /**
   * Inserts a new row into a table
   * @param tableName - Name of the table
   * @param values - Map of column names to values
   * @returns Promise resolving to the last insert row ID
   */
  async storageInsertRow(
    tableName: string,
    values: Record<string, any>
  ): Promise<number> {
    try {
      return await apiCall<number>("storage_insert_row", {
        tableName,
        values,
      });
    } catch (error) {
      console.error("Failed to insert row:", error);
      throw error;
    }
  },

  /**
   * Executes a raw SQL query
   * @param query - SQL query string
   * @returns Promise resolving to query result
   */
  async storageExecuteSql(query: string): Promise<any> {
    try {
      return await apiCall<any>("storage_execute_sql", { query });
    } catch (error) {
      console.error("Failed to execute SQL:", error);
      throw error;
    }
  },

  /**
   * Resets the entire database
   * @returns Promise resolving when the database is reset
   */
  async storageResetDatabase(): Promise<void> {
    try {
      return await apiCall<void>("storage_reset_database");
    } catch (error) {
      console.error("Failed to reset database:", error);
      throw error;
    }
  },

  // Theme settings helpers

  /**
   * Gets a setting from the app_settings table via the dedicated
   * `get_setting` IPC channel (which hits `db.getSetting` directly).
   *
   * Previously this went through `storageReadTable('app_settings', ...)` which
   * worked, but the paired `saveSetting` used `storageUpdateRow` which
   * silently no-ops for missing keys — so new keys never got persisted. Now
   * both sides use the upsert-safe `get_setting`/`save_setting` pair.
   *
   * localStorage mirror is kept as a startup-flicker fast-path.
   */
  async getSetting(key: string): Promise<string | null> {
    try {
      if (typeof window !== 'undefined' && 'localStorage' in window) {
        const cached = window.localStorage.getItem(`app_setting:${key}`);
        if (cached !== null) {
          return cached;
        }
      }
      const value = await apiCall<string | null>('get_setting', { key });
      return value ?? null;
    } catch (error) {
      console.error(`Failed to get setting ${key}:`, error);
      return null;
    }
  },

  /**
   * Saves a setting to the app_settings table via the `save_setting` IPC
   * channel, which uses `INSERT ... ON CONFLICT(key) DO UPDATE` and handles
   * both first-insert and update correctly.
   */
  async saveSetting(key: string, value: string): Promise<void> {
    try {
      if (typeof window !== 'undefined' && 'localStorage' in window) {
        try {
          window.localStorage.setItem(`app_setting:${key}`, value);
        } catch (_ignore) {
          // best-effort; continue to persist in DB
        }
      }
      await apiCall('save_setting', { key, value });
    } catch (error) {
      console.error(`Failed to save setting ${key}:`, error);
      throw error;
    }
  },

  /**
   * Get hooks configuration for a specific scope.
   * `configDir` is required for the `user` scope so we never silently read ~/.claude.
   */
  async getHooksConfig(
    scope: 'user' | 'project' | 'local',
    projectPath?: string,
    configDir?: string
  ): Promise<HooksConfiguration> {
    try {
      return await apiCall<HooksConfiguration>("get_hooks_config", { scope, projectPath, configDir });
    } catch (error) {
      console.error("Failed to get hooks config:", error);
      throw error;
    }
  },

  /**
   * Update hooks configuration for a specific scope.
   * `configDir` is required for the `user` scope so we never silently write to ~/.claude.
   */
  async updateHooksConfig(
    scope: 'user' | 'project' | 'local',
    hooks: HooksConfiguration,
    projectPath?: string,
    configDir?: string
  ): Promise<string> {
    try {
      return await apiCall<string>("update_hooks_config", { scope, projectPath, hooks, configDir });
    } catch (error) {
      console.error("Failed to update hooks config:", error);
      throw error;
    }
  },

  /**
   * Validate a hook command syntax
   * @param command - The shell command to validate
   * @returns Promise resolving to validation result
   */
  async validateHookCommand(command: string): Promise<{ valid: boolean; message: string }> {
    try {
      return await apiCall<{ valid: boolean; message: string }>("validate_hook_command", { command });
    } catch (error) {
      console.error("Failed to validate hook command:", error);
      throw error;
    }
  },

  /**
   * Get merged hooks configuration (respecting priority).
   * `configDir` is required so the user-scope read doesn't silently fall back to ~/.claude.
   */
  async getMergedHooksConfig(projectPath: string, configDir?: string): Promise<HooksConfiguration> {
    try {
      const [userHooks, projectHooks, localHooks] = await Promise.all([
        this.getHooksConfig('user', undefined, configDir),
        this.getHooksConfig('project', projectPath, configDir),
        this.getHooksConfig('local', projectPath, configDir)
      ]);

      // Import HooksManager for merging
      const { HooksManager } = await import('@/lib/hooksManager');
      return HooksManager.mergeConfigs(userHooks, projectHooks, localHooks);
    } catch (error) {
      console.error("Failed to get merged hooks config:", error);
      throw error;
    }
  },

  // Slash Commands API methods

  /**
   * Lists all available slash commands
   * @param projectPath - Optional project path to include project-specific commands
   * @returns Promise resolving to array of slash commands
   */
  async slashCommandsList(projectPath?: string, configDir?: string): Promise<SlashCommand[]> {
    try {
      return await apiCall<SlashCommand[]>("slash_commands_list", { projectPath, configDir });
    } catch (error) {
      console.error("Failed to list slash commands:", error);
      throw error;
    }
  },

  /**
   * Gets a single slash command by ID
   * @param commandId - Unique identifier of the command
   * @returns Promise resolving to the slash command
   */
  async slashCommandGet(commandId: string, configDir?: string): Promise<SlashCommand> {
    try {
      return await apiCall<SlashCommand>("slash_command_get", { commandId, configDir });
    } catch (error) {
      console.error("Failed to get slash command:", error);
      throw error;
    }
  },

  /**
   * Creates or updates a slash command
   * @param scope - Command scope: "project" or "user"
   * @param name - Command name (without prefix)
   * @param namespace - Optional namespace for organization
   * @param content - Markdown content of the command
   * @param description - Optional description
   * @param allowedTools - List of allowed tools for this command
   * @param projectPath - Required for project scope commands
   * @returns Promise resolving to the saved command
   */
  async slashCommandSave(
    scope: string,
    name: string,
    namespace: string | undefined,
    content: string,
    description: string | undefined,
    allowedTools: string[],
    projectPath?: string,
    configDir?: string
  ): Promise<SlashCommand> {
    try {
      return await apiCall<SlashCommand>("slash_command_save", {
        scope,
        name,
        namespace,
        content,
        description,
        allowedTools,
        projectPath,
        configDir
      });
    } catch (error) {
      console.error("Failed to save slash command:", error);
      throw error;
    }
  },

  /**
   * Deletes a slash command
   * @param commandId - Unique identifier of the command to delete
   * @param projectPath - Optional project path for deleting project commands
   * @returns Promise resolving to deletion message
   */
  async slashCommandDelete(commandId: string, projectPath?: string, configDir?: string): Promise<string> {
    try {
      return await apiCall<string>("slash_command_delete", { commandId, projectPath, configDir });
    } catch (error) {
      console.error("Failed to delete slash command:", error);
      throw error;
    }
  },

  // ── Session Summaries ───────────────────────────────────────

  /**
   * Read the cached summary sidecar for a session. Null when no sidecar
   * exists or the on-disk file is unreadable / version-mismatched.
   *
   * `configDir` is the resolved account's `config_dir` — held at tab
   * level by the renderer (`accountResolution.account.config_dir` in
   * `ClaudeCodeSession`, or from `resolveAccountForProject` in
   * `SessionList`). Pass `null` only if you don't yet know which
   * account owns the session; the backend will scan all known accounts
   * as a fallback.
   */
  async summaryGet(
    sessionUuid: string,
    projectPath: string,
    configDir: string | null,
  ): Promise<SessionSummary | null> {
    return apiCall<SessionSummary | null>("summary_get", {
      sessionUuid,
      projectPath,
      configDir,
    });
  },

  /**
   * Generate (or regenerate) a summary for a session. See
   * `SummaryGenerateResult` for return shape; throws on hard errors
   * (auth expired, network failure) so callers can surface a toast.
   */
  async summaryGenerate(
    sessionUuid: string,
    projectPath: string,
    configDir: string | null,
  ): Promise<SummaryGenerateResult> {
    return apiCall<SummaryGenerateResult>("summary_generate", {
      sessionUuid,
      projectPath,
      configDir,
    });
  },

  /**
   * Update an account's per-session summary opt-in.
   *
   * `summarizeOnClose` toggles the auto-on-close generation; `summaryModel`
   * is the model id (e.g. 'haiku', 'sonnet', 'opus', or a full SDK id like
   * 'claude-haiku-4-5'). Pass `null` to clear the model. Both fields are
   * required for generation — toggling on while model is null leaves the
   * feature off in practice.
   */
  async accountUpdateSummary(
    id: number,
    summarizeOnClose: boolean,
    summaryModel: string | null,
  ): Promise<void> {
    return apiCall<void>('update_account_summary', {
      id,
      summarizeOnClose,
      summaryModel,
    });
  },

  /**
   * Subscribe to summary-updated events. The main process emits
   * `session-summary:updated` after a successful sidecar write so the
   * renderer can refresh the matching row. Returns an unsubscribe
   * function; matches the pattern used by other event subscriptions in
   * this file.
   */
  onSessionSummaryUpdated(
    callback: (payload: { sessionUuid: string }) => void,
  ): () => void {
    return window.electronAPI.onEvent(
      'session-summary:updated',
      (data: any) => {
        if (!data || typeof data !== 'object' || typeof data.sessionUuid !== 'string') return;
        callback({ sessionUuid: data.sessionUuid });
      },
    );
  },

  /**
   * Snapshot of session uuids whose summary model call is currently
   * in flight on the main process. Returned as a plain array.
   *
   * SessionList calls this on mount so it can spin the per-row refresh
   * icon for background auto-on-close runs that started before the
   * component had a chance to subscribe to `session-summary:generating`
   * events — common when the user clicks the back button inside a
   * session, since the close lifecycle fires its event within the same
   * frame as the navigation.
   */
  async getGeneratingSummaryUuids(): Promise<string[]> {
    const result = await apiCall<unknown>('summary_generating_now', {});
    if (!Array.isArray(result)) return [];
    return result.filter((x): x is string => typeof x === 'string');
  },

  /**
   * Subscribe to generation-state events. The main process emits
   * `session-summary:generating` with `generating: true` when a model
   * call starts and `generating: false` when it finishes (success or
   * thrown). Used by SessionList to spin the per-row refresh icon
   * during background auto-on-close runs.
   *
   * Note: skipped paths (no-account, no-model, unchanged size-gate,
   * empty-session, etc.) do NOT emit either event — the model is never
   * called, so there's nothing to spin for.
   */
  onSessionSummaryGenerating(
    callback: (payload: { sessionUuid: string; generating: boolean }) => void,
  ): () => void {
    return window.electronAPI.onEvent(
      'session-summary:generating',
      (data: any) => {
        if (
          !data ||
          typeof data !== 'object' ||
          typeof data.sessionUuid !== 'string' ||
          typeof data.generating !== 'boolean'
        ) {
          return;
        }
        callback({ sessionUuid: data.sessionUuid, generating: data.generating });
      },
    );
  },

  // ── Account Management ─────────────────────────────────────

  async listAccounts(): Promise<Account[]> {
    return apiCall<Account[]>('list_accounts');
  },

  async createAccount(
    name: string,
    configDir: string,
    accountType?: string,
    color?: string,
    icon?: string,
    sessionDefaults?: SessionDefaults,
    cliPath?: string | null,
  ): Promise<Account> {
    // No isDefault parameter — there is no notion of a default account.
    // Account binding is via path rules / project overrides; failure to
    // resolve surfaces as a NoAccountError. See electron/services/accounts.ts.
    const params: Record<string, any> = { name, configDir };
    if (accountType) params.accountType = accountType;
    if (color) params.color = color;
    if (icon !== undefined) params.icon = icon;
    if (sessionDefaults !== undefined) params.sessionDefaults = sessionDefaults;
    if (cliPath !== undefined) params.cliPath = cliPath;
    return apiCall<Account>('create_account', params);
  },

  async updateAccount(
    id: number,
    name: string,
    configDir: string,
    accountType?: string,
    color?: string,
    icon?: string,
    sessionDefaults?: SessionDefaults | null,
    cliPath?: string | null,
  ): Promise<void> {
    const params: Record<string, any> = { id, name, configDir };
    if (accountType) params.accountType = accountType;
    if (color !== undefined) params.color = color;
    if (icon !== undefined) params.icon = icon;
    if (sessionDefaults !== undefined) params.sessionDefaults = sessionDefaults;
    if (cliPath !== undefined) params.cliPath = cliPath;
    return apiCall<void>('update_account', params);
  },

  async deleteAccount(id: number): Promise<void> {
    return apiCall<void>('delete_account', { id });
  },

  async listPathRules(): Promise<PathRule[]> {
    return apiCall<PathRule[]>('list_path_rules');
  },

  async addPathRule(accountId: number, pathPrefix: string, priority: number = 0): Promise<void> {
    return apiCall<void>('add_path_rule', { accountId, pathPrefix, priority });
  },

  async removePathRule(ruleId: number): Promise<void> {
    return apiCall<void>('remove_path_rule', { ruleId });
  },

  async resolveAccountForProject(projectPath: string): Promise<Account | null> {
    return apiCall<Account | null>('resolve_account_for_project', { projectPath });
  },

  async setProjectAccountOverride(projectPath: string, accountId: number): Promise<void> {
    return apiCall<void>('set_project_account_override', { projectPath, accountId });
  },

  async listProjectOverrides(): Promise<ProjectOverride[]> {
    return apiCall<ProjectOverride[]>('list_project_overrides');
  },

  async discoverAccounts(): Promise<[string, string][]> {
    return apiCall<[string, string][]>('discover_accounts');
  },

  /**
   * Resolve account for a project path with explanation of why it matched
   */
  async explainAccountResolution(projectPath: string): Promise<{
    account: Account;
    match_type: string;
    match_detail: string;
  } | null> {
    return apiCall("explain_account_resolution", { projectPath });
  },

  // ---------------------------------------------------------------------------
  // Updater
  // ---------------------------------------------------------------------------

  async getAppVersion(): Promise<string> {
    return apiCall("get_app_version", {});
  },

  async checkForUpdate(): Promise<{
    available: boolean;
    version: string;
    downloadUrl: string;
    assetName: string;
    releaseUrl: string;
    releaseNotes?: string;
  } | null> {
    return apiCall("updater:check", {});
  },

  async downloadUpdate(url: string, assetName?: string): Promise<string> {
    return apiCall("updater:download", { url, assetName });
  },

  async openUpdate(filePath: string): Promise<void> {
    return apiCall("updater:open", { filePath });
  },

  async installUpdate(zipPath: string, version: string, opts?: { force?: boolean }): Promise<void> {
    return apiCall("updater:install", {
      zipPath,
      version,
      ...(opts?.force ? { force: true } : {}),
    });
  },

  async cancelInstall(): Promise<void> {
    return apiCall("updater:install-cancel", {});
  },

  /**
   * Subscribe to live changes in the count of sessions whose SDK turn is
   * currently in flight (`'starting' | 'running' | 'waiting_permission'`).
   * Used by the titlebar to surface a warning on the upgrade button before
   * the user clicks install.
   */
  onSessionInFlightCount(cb: (count: number) => void): () => void {
    return window.electronAPI.onEvent(
      'session-inflight-count',
      (data: any) => cb(typeof data?.count === 'number' ? data.count : 0),
    );
  },

  onInstallStatus(
    cb: (data: {
      phase: 'waiting' | 'installing';
      activeSessions?: number;
      tabs?: Array<{ tabId: string; status: string }>;
    }) => void,
  ): () => void {
    return window.electronAPI.onEvent('updater:install-status', cb as any);
  },

  onUpdateProgress(callback: (data: { percent: number; bytesDownloaded: number; totalBytes: number }) => void): () => void {
    return window.electronAPI.onEvent('updater:progress', callback as any);
  },

  // ── Tab Status ────────────────────────────────────────────────
  /**
   * Push this tab's busy/idle summary up to main so the status popover and
   * the install-gate can read a single source of truth. Renderer is the
   * canonical interpreter (knows messages, subagents, todos); main is the
   * canonical aggregator across all open tabs.
   */
  async publishTabStatus(summary: TabStatusSummary): Promise<void> {
    return apiCall('tab_status_publish', { summary });
  },

  async removeTabStatus(tabId: string): Promise<void> {
    return apiCall('tab_status_remove', { tabId });
  },

  async listTabStatuses(): Promise<TabStatusSummary[]> {
    return apiCall<TabStatusSummary[]>('tab_status_list', {});
  },

  /**
   * Subscribe to the live list of tab summaries. Fires whenever any tab
   * publishes or is removed. The list is in tab-bar order.
   */
  onTabStatusesChanged(cb: (summaries: TabStatusSummary[]) => void): () => void {
    return window.electronAPI.onEvent(
      'tab-status:changed',
      (data: any) => cb(Array.isArray(data) ? data : []),
    );
  },

  // ── Branch Colors ─────────────────────────────────────────────
  async listBranchColors(projectPath: string): Promise<BranchColor[]> {
    return apiCall<BranchColor[]>('branch_colors_list', { projectPath });
  },
  async upsertBranchColor(input: { projectPath: string; branchName: string; color: string }): Promise<BranchColor> {
    return apiCall<BranchColor>('branch_colors_upsert', input);
  },
  async deleteBranchColor(id: number): Promise<boolean> {
    return apiCall<boolean>('branch_colors_delete', { id });
  },
  async listGitBranches(projectPath: string): Promise<string[]> {
    return apiCall<string[]>('git_list_branches', { projectPath });
  },

};
