import { apiCall } from './apiAdapter';
import { platform } from './platform';
import type { ModInspection } from "./mods";
import type { HooksConfiguration } from '@/types/hooks';
import type { SideChat, SideChatAskResult } from '@/lib/sideChat';
import type { TaskOutputTail } from '@/lib/backgroundShells';

/** The daemon can't tell `undefined` from missing. */
function stripUndefined(obj: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj as Record<string, unknown>).filter(([, v]) => v !== undefined));
}

/** Mirrors `AgentKind` in daemon/services/agents/types.ts. */
export type AgentKind = 'claude' | 'codex';

/** Mirrors `AgentMessage` in daemon/services/agents/types.ts. */
export interface AgentMessage {
  agent: AgentKind;
  tabId: string;
  receivedAt: string;
  sessionId: string | null;
  payload: unknown;
}

/** Mirrors `CodexAuthStatus` in daemon/services/auth/codex-auth.ts. */
export interface CodexAuthStatus {
  authenticated: boolean;
  email?: string;
  mode?: 'oauth' | 'apikey';
}

export interface Project {
  id: string;
  path: string;
  sessions: string[];
  created_at: number;
  /** Newest session JSONL mtime: when Claude was last used here, not when files changed. */
  most_recent_session?: number;
  account_id?: number;
  account_name?: string;
  pinned: boolean;
}

export interface SessionDefaults {
  model?: string;
  permissionMode?: string;
  effort?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** Mirrors backend AccountEngine. */
export type AccountEngine = AgentKind;

export interface Account {
  id: number;
  name: string;
  config_dir: string;
  // No is_default: there is no default account; an unresolved project raises NoAccountError.
  /** Immutable after create. */
  engine: AccountEngine;
  subscription_label: string;
  has_cost: boolean;
  color: string | null;
  icon: string | null;
  session_defaults?: SessionDefaults;
  cli_path: string | null;
  /** Null skips identity verification for this account. */
  expected_email: string | null;
  created_at: string;
  updated_at: string;
  summarizeOnClose?: boolean;
  /** Null means no model: summaries stay off whatever the toggle says. */
  summaryModel?: string | null;
}

/** Mirrors the /usage parser shape in daemon/services/usage-runner.ts. */
export interface UsageRunData {
  /** The CLI replayed last-known bars; the numbers predate the scrape. */
  stale: boolean;
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
  windows: {
    label: 'current_session' | 'week_all_models' | 'week_sonnet';
    pct_used: number;
    resets_at_label: string;
  }[];
  contributing: { headline: string; detail: string }[];
  /** Names arrive truncated by the CLI; `more_count` is null when fully enumerated. */
  skills: { rows: { name: string; pct_used: number }[]; more_count: number | null };
  subagents: { rows: { name: string; pct_used: number }[]; more_count: number | null };
  plugins: { rows: { name: string; pct_used: number }[]; more_count: number | null };
  mcp_servers: { rows: { name: string; pct_used: number }[]; more_count: number | null };
  /** `tokens`/`per_run` stay the CLI's abbreviated strings: parsing them would invent precision. */
  loops: {
    rows: {
      prompt: string;
      every: string;
      runs: number;
      tokens: string;
      per_run: string | null;
      last_run: string;
    }[];
    more_count: number | null;
  };
}

export type UsageRunResult =
  | { ok: true; observed_at: number; raw: string; parsed: UsageRunData }
  | { ok: false; observed_at: number; error: string; raw?: string };

export type ValidateCliPathResult = { ok: true } | { ok: false; error: string };

export interface ProjectRepo {
  path: string;
  /** Relative to the project folder. */
  name: string;
  watched: boolean;
  missing: boolean;
}

export interface ProjectRepos {
  scanDepth: number;
  rootIsRepo: boolean;
  rootPath: string;
  repos: ProjectRepo[];
  truncated: boolean;
}

export interface BranchColor {
  id: number;
  repo_path: string;
  branch_name: string;
  color: string;
  sort_order: number;
  created_at: number;
}

export interface PathRule {
  id: number;
  account_id: number;
  account_name: string;
  account_engine: AccountEngine;
  path_prefix: string;
  priority: number;
}

export interface ProjectOverride {
  project_path: string;
  engine: AccountEngine;
  account_id: number;
  account_name: string;
}

export interface ResolveSlot {
  account: Account;
  /** `on_disk`: the session dir exists under exactly one account's config dir. Mirrors `ResolveMatchType`. */
  matchType: 'override' | 'path_rule' | 'on_disk';
  matchDetail: string;
}

/** An all-null pair is an error, never a default-account fallback. */
export interface ResolvePair {
  claude: ResolveSlot | null;
  codex: ResolveSlot | null;
}

export interface DiscoveredConfigDir {
  dirName: string;
  configDir: string;
  engine: AccountEngine;
}

export interface Session {
  id: string;
  project_id: string;
  project_path: string;
  todo_data?: any;
  created_at: number;
  ai_title?: string;
  /** Outranks `ai_title`; resolve both via `pickSessionTitle`. */
  custom_title?: string;
  first_timestamp?: string;
  last_timestamp?: string;
  /** @deprecated Filesystem mtime fallback. Prefer `last_timestamp`. */
  message_timestamp?: string;
  file_size_bytes?: number;
}

export type ClaudeSettings = Record<string, any>;

export interface PathSnapshot {
  path: string;
  branch: string | null;
  changed: number;
  untracked: number;
  error: string | null;
}

export interface RepoSnapshot {
  /** Relative to the project folder; '' for the project folder itself. */
  name: string;
  root: PathSnapshot;
  worktrees: PathSnapshot[];
}

export interface SessionGitSnapshot {
  /** The project folder's repo first (when it is one), then watched sub-repos. */
  repos: RepoSnapshot[];
  foundCount: number;
}

type IpcRecord = Record<string, unknown>;

function isIpcRecord(value: unknown): value is IpcRecord {
  return value !== null && typeof value === 'object';
}

function normalizePathSnapshot(raw: unknown, fallbackPath: string): PathSnapshot {
  const data = isIpcRecord(raw) ? raw : undefined;
  return {
    path: typeof data?.path === 'string' ? data.path : fallbackPath,
    branch: (data?.branch ?? null) as string | null,
    changed: typeof data?.changed === 'number' ? data.changed : 0,
    untracked: typeof data?.untracked === 'number' ? data.untracked : 0,
    error: typeof data?.error === 'string' ? data.error : null,
  };
}

export type GitChangedFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked';

export interface GitChangedFile {
  /** Repo-relative path, forward slashes, as git reports it. */
  path: string;
  status: GitChangedFileStatus;
  staged: boolean;
  origPath?: string;
}

export interface WorktreeInfo {
  /** Realpath-resolved. */
  path: string;
  branch: string | null;
}

export interface LimaVm {
  name: string;
  status: string;
  arch: string;
  cpus: number;
  memoryBytes: number;
  diskBytes: number;
  dir: string;
}

export interface LimaDockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

/** Mirrors `CliReviewStatus` in daemon/services/claude-cli-review.ts. */
export interface CliReviewStatus {
  installed_version: string | null;
  reviewed_version: string;
  /** Floored at `reviewed_version`; ahead of it means read but not yet shipped in a build. */
  checked_version: string;
  /** Strictly newer than `checked_version`. */
  unreviewed: boolean;
  latest_version: string | null;
  /** Deliberately separate from `unreviewed`. */
  upgrade_available: boolean;
  repo_dir: string | null;
}

/** Mirrors `CliAccountUpdateResult`. */
export interface CliAccountUpdateResult {
  account: string;
  ok: boolean;
  message: string;
}

/** Mirrors `CliUpdateResult`. */
export interface CliUpdateResult {
  from: string | null;
  to: string | null;
  upgraded: boolean;
  accounts: CliAccountUpdateResult[];
}

/** Mirrors `CLI_AUTO_UPDATE_SETTING_KEY` in daemon/services/claude-cli-review.ts. */
export const CLI_AUTO_UPDATE_SETTING_KEY = 'claude_cli_auto_update_on_launch';

/** Mirrors `CLI_REVIEW_REPO_DIR_SETTING_KEY` in daemon/services/claude-cli-review.ts. */
export const CLI_REVIEW_REPO_DIR_SETTING_KEY = 'cli_review_repo_dir';

/** Mirrors `CLI_CHECKED_VERSION_SETTING_KEY` in daemon/services/claude-cli-review.ts. */
/** Notification id prefix for a new Claude Code release; the click handler matches on it. */
export const CLI_RELEASE_NOTICE_ID_PREFIX = 'claude-cli-update:';
export const CLI_CHECKED_VERSION_SETTING_KEY = 'claude_cli_checked_version';

export interface ClaudeVersionStatus {
  is_installed: boolean;
  version?: string;
  output: string;
}

export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
  extension?: string;
}

export interface ClaudeInstallation {
  path: string;
  version?: string;
  source: string;
  installation_type: "System" | "Custom";
}

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

/** Mirrors `SessionCostSnapshot` in daemon/services/cost/session-cost-core.ts. */
export interface SessionCostSnapshot {
  totalUsd: number;
  estimated: boolean;
  breakdown: { inputUsd: number; outputUsd: number; cacheReadUsd: number; cacheWriteUsd: number };
  subagentUsd: number;
  byModel: { model: string; usd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Keyed by agent id (`agent-<id>.jsonl`). */
  bySubagent: Record<string, SubagentCost>;
}

/** Mirrors `SubagentCost` in session-cost-core.ts. */
export interface SubagentCost {
  usd: number;
  estimated: boolean;
  contextTokens: number;
  model: string;
}

/** Mirrors `CostHistoryPeriod` in daemon/services/cost/cost-history.ts. */
export interface CostHistoryPeriod {
  period: string;
  cost_usd: number;
  request_count: number;
  /** Distinct sessions in this period. NOT summable across periods. */
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  input_usd: number;
  output_usd: number;
  cache_read_usd: number;
  cache_write_usd: number;
  is_estimated: number;
}

export interface CostHistoryPeriodModel extends CostHistoryPeriod {
  model: string;
}

interface CostGroupSums {
  cost_usd: number;
  request_count: number;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface CostByProject extends CostGroupSums {
  project_path: string | null;
}

export interface CostByModel extends CostGroupSums {
  model: string;
}

export interface CostByProjectModel extends CostByModel {
  project_path: string | null;
}

export interface CostComponents {
  cost_usd: number;
  input_usd: number;
  output_usd: number;
  cache_read_usd: number;
  cache_write_usd: number;
  context_share: number;
}

export interface CachingRoi {
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_1h_tokens: number;
  cache_read_usd: number;
  cache_write_usd: number;
  read_write_ratio: number;
  /** Below ~2 reads per write caching costs more than it saves; the UI must say so. */
  below_break_even: boolean;
  saved_usd: number;
  premium_1h_usd: number;
}

export interface SubagentSplitRow {
  /** 0 = main loop, 1 = subagent. */
  is_subagent: number;
  cost_usd: number;
  request_count: number;
  usd_per_request: number;
}

export interface UnpricedModel {
  model: string;
  request_count: number;
  cost_usd: number;
}

// Re-exported from the shared pricing module; redeclaring it here would drift.
export type { ModelPricingInput, ModelPricingRow } from '@/lib/pricing';
import type { ModelPricingInput, ModelPricingRow } from '@/lib/pricing';
import type { CostFilterState } from '@/lib/costReportFilters';
import type { PrintMeasurement } from '@/lib/costReportPrintMeasure';
import { buildPrintHash } from '@/lib/costReportPrint';

/** `session_count` is counted once over the range, never summed per period. */
export interface CostTotals {
  cost_usd: number;
  request_count: number;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface CostFacets {
  accounts: string[];
  models: string[];
  projects: string[];
  minDate: string | null;
  maxDate: string | null;
}

/** Mirrors `CostSessionRow` in daemon/services/cost/cost-history.ts. */
export interface CostSessionRow {
  session_id: string;
  account_name: string;
  project_path: string | null;
  first_date: string;
  last_date: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/** An array ORs its values; an empty array means no filter. */
export interface CostHistoryFilterParams {
  startDate?: string;
  endDate?: string;
  accountName?: string | string[];
  projectPath?: string | string[];
  model?: string | string[];
  isSubagent?: boolean;
}

export interface RateLimitSnapshot {
  account_name: string;
  rate_limit_type: string;
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** 0–100. */
  utilization: number | null;
  /** Unix epoch seconds. */
  resets_at: number | null;
  /** Unix epoch ms. */
  observed_at: number;
}

export interface RateLimitSettings {
  notifications_enabled: boolean;
  five_hour_thresholds_pct: number[];
  seven_day_notifications_enabled: boolean;
  seven_day_thresholds_pct: number[];
  sound_enabled: boolean;
}

export interface MCPServer {
  name: string;
  transport: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  scope: string;
  is_active: boolean;
  status: ServerStatus;
}

export interface ServerStatus {
  running: boolean;
  error?: string;
  last_checked?: number;
}

export interface SessionMcpServerStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: { name: string; version: string };
  error?: string;
  config?: Record<string, unknown>;
  scope?: string;
  /** Reached through the cloud session's MCP proxy; its sign-in is held there. */
  sessionProxied?: boolean;
  tools?: { name: string; description?: string }[];
}

export interface ClaudeSignInFlow {
  flowId: string;
  /** Shows a code to paste back — works from any device. */
  manualUrl: string;
  /** Redirects to the CLI on the daemon's machine and finishes by itself. */
  automaticUrl: string;
}

export interface ClaudeSignedInAccount {
  email?: string;
  organization?: string;
  subscriptionType?: string;
}

/** Mirrors McpAuthResult in daemon/services/sessions/types.ts. */
export interface McpAuthResult {
  authUrl: string | null;
  requiresUserAction: boolean;
  callbackExpected: boolean;
}

export interface SessionPluginInfo {
  name: string;
  path: string;
  source?: string;
  scope: 'user' | 'project' | 'local' | 'builtin' | 'unknown';
  version?: string;
  description?: string;
  author?: string;
  authorEmail?: string;
  /** `inspection` is null when `claude plugin validate` could not read it. */
  mod: { modules: string[]; inspection: ModInspection | null } | null;
}

export interface SubagentMetaEntry {
  agentId?: string;
  agentType?: string;
  description?: string;
  model?: string;
  effort?: string;
  /** Set only for nested subagents, which the main stream never mentions. */
  parentAgentId?: string;
  spawnDepth?: number;
  totalTokens?: number;
  durationMs?: number;
  toolUseCount?: number;
  status?: string;
}

export interface MCPProjectConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface MCPServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface SlashCommand {
  id: string;
  name: string;
  full_command: string;
  scope: string;
  namespace?: string;
  file_path: string;
  content: string;
  description?: string;
  allowed_tools: string[];
  has_bash_commands: boolean;
  has_file_references: boolean;
  accepts_arguments: boolean;
}

export interface AddServerResult {
  success: boolean;
  message: string;
  server_name?: string;
}

export interface ImportResult {
  imported_count: number;
  failed_count: number;
  servers: ImportServerResult[];
}

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

/** Mirrors LogOrderBy in daemon/services/logging.ts. */
export type LogOrderBy = 'timestamp' | 'level' | 'source' | 'category' | 'message';
export type LogOrderDir = 'asc' | 'desc';

/** Mirrors `SessionStatus` in daemon/services/sessions/types.ts. */
export type SessionStatus =
  | 'starting'
  | 'started'
  | 'error'
  | 'stopped';

/** Mirrors `TurnState` in daemon/services/sessions/types.ts. */
export interface TurnState { status: 'idle' | 'running'; since: string | null }

/** @deprecated Import from `src/lib/sessionDerivedState.ts`. */
export type ConversationStatus = import('./sessionDerivedState').ConversationStatus;

export interface LogQueryFilters {
  levels?: string[];
  sources?: string[];
  search?: string;
  since?: string;
  until?: string;
  limit: number;
  offset: number;
  orderBy?: LogOrderBy;
  orderDir?: LogOrderDir;
}

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

export interface SessionAccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'mantle';
}

/** From `.claude.json`; may be stale after logout, as the CLI leaves `oauthAccount` behind. */
export interface AccountIdentity {
  email: string | null;
  displayName: string | null;
  organizationName: string | null;
  organizationType: string | null;
}

/** Authoritative, but costs a process spawn: explicit user action only. */
export interface AccountAuthStatus {
  loggedIn: boolean;
  email: string | null;
  authMethod: string | null;
  apiProvider: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  loginExpiresAt: string | null;
}

export interface LoginExpiry {
  expiresAt: string | null;
  checkedAt: string;
}

/** `unknown-account` is a bug to surface; `unverified` is the user's choice. */
export type IdentityStatus =
  | 'verified'
  | 'mismatch'
  | 'signed-out'
  | 'unverified'
  | 'unknown-account';

export interface IdentityVerdict {
  status: IdentityStatus;
  expected: string | null;
  detected: string | null;
  configDir: string;
}

/** `detected: null` means nobody is signed in. */
export interface AccountMismatch {
  expected: string;
  detected: string | null;
  configDir: string;
  source: 'oauth-file' | 'session-init';
}

/** Mirrors `CliPermissionRuleSource` in daemon/services/sessions/types.ts. */
export type CliPermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session'
  | 'toolsNarrowing'
  | 'mcpServerPolicy'
  | 'hostCredential';

/** `emphasis` is rule content and may carry invisible characters: never render it unescaped. */
export interface CliPermissionRuleDescription {
  prefix: string;
  emphasis?: string;
  suffix?: string;
}

export interface CliPermissionRule {
  behavior: 'allow' | 'deny' | 'ask';
  source: CliPermissionRuleSource;
  /** The stored rule string VERBATIM — escape at display, never match raw. */
  rule: string;
  description?: CliPermissionRuleDescription;
  editability: 'persistent' | 'session' | 'readonly';
  notInEffect?: boolean;
}

export interface CliWorkspaceDirectory {
  path: string;
  source: string;
}

export interface CliPermissionRulesState {
  rules: CliPermissionRule[];
  workspaceDirectories: CliWorkspaceDirectory[];
  originalCwd: string;
  managedOnly: boolean;
  errors?: unknown[];
}

export interface SessionContextUsageCategory {
  /** Absent from older CLIs; a later CLI may add values. */
  id?: string;
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

export interface TabStatusTasks {
  total: number;
  completed: number;
  inFlight: boolean;
}

export interface TabStatusSummary {
  tabId: string;
  title: string;
  projectPath: string | null;
  /** The CLI session GUID, not the renderer-local `tabId`; null before one exists. */
  sessionId: string | null;
  sessionStarted: boolean;
  /** Includes a pending permission; pending todos don't count. */
  busy: boolean;
  /** Unlike `busy`, a session waiting on the user is not working. */
  promptStatus: 'working' | 'ready';
  mainTurnInFlight: boolean;
  activeAgents: number;
  tasks: TabStatusTasks;
  contextUsage: {
    totalTokens: number;
    maxTokens: number;
    percentage: number;
  } | null;
  branch: string | null;
  filesChanged: number;
  filesUntracked: number;
  status: 'not-started' | 'starting' | 'idle' | 'busy' | 'error';
  waitingFor: 'permission' | 'question' | null;
  updatedAt: number;
}

export interface SessionSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

// Mirrors daemon/services/sessions-summary.ts.
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
  promptHash?: string;
  /** @deprecated older sidecars used a numeric version; kept for read-back only. */
  promptVersion?: number;
}

/** Mirrors the backend constant in sessions-summary.ts. */
export const PROMPT_TEMPLATE_SETTING_KEY = 'sessionsSummary.promptTemplate';

/** Mirrors sessions-summary.ts; stored as `'true'` or `'false'`. */
export const ENABLED_SETTING_KEY = 'sessionsSummary.enabled';

/** Mirrors sessions-summary.ts; stored as `'true'` or `'false'`. */
export const AUTO_ON_CLOSE_SETTING_KEY = 'sessionsSummary.autoOnClose';

/** Mirrors `SummaryGenerateResult` in daemon/services/sessions-summary.ts. */
export type SummaryGenerateResult =
  | { status: 'generated'; summary: SessionSummary }
  | { status: 'unchanged'; summary: SessionSummary }
  | {
      status: 'skipped';
      reason: 'no-account' | 'toggle-off' | 'no-model' | 'empty-session' | 'jsonl-missing' | 'jsonl-unreadable';
    }
  | { status: 'malformed-response' };

/** Mirrors `CliStatusReport`. Values are the CLI's rendered text — display them, don't parse them. */
export interface SessionStatusReport {
  sections: { title: string; rows: { label?: string; value: string }[] }[];
}

export interface SessionModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[];
}

/** Mirrors the backend `SearchHit` in daemon/services/brain/search.ts. */
export interface BrainSearchHit {
  notePath: string;
  type: string;
  title: string;
  snippet: string;
  /** Raw bm25 score. More negative is a better match. */
  score: number;
}

/** Mirrors NOTE_TYPES in daemon/services/brain/types.ts. */
export type BrainNoteType = 'Project' | 'Subsystem' | 'Topic' | 'Session' | 'Note';

/** Mirrors the backend `VaultStatus` in daemon/services/brain/registry.ts. */
export interface BrainVaultStatus {
  accountId: number;
  configured: boolean;
  path: string | null;
  exists: boolean;
  initialized: boolean;
  noteCount: number;
  indexedCount: number | null;
  gitAvailable: boolean;
  lastGitError: string | null;
  conflict: string | null;
  /** Null means not determined, never zero. */
  offloadedCount: number | null;
}

/** Mirrors the backend `SourceSummary` in daemon/services/brain/registry.ts. */
export interface BrainSourceSummary {
  accountId: number;
  sourceId: string;
  itemKey: string;
  name: string;
  inUse: boolean;
  /** Null means nothing was ever spent, not a free run. */
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  label: string;
  mtimeMs: number;
  size: number;
  admitted: boolean;
  reason: string;
  excluded: boolean;
  /** Mirrors `SourceStatus` in daemon/services/brain/sources/state.ts. */
  status: 'pending' | 'indexed' | 'skipped' | 'failed' | 'blocked' | null;
  changed: boolean;
}

/** Mirrors the backend `SessionMetadata` in daemon/services/brain/sources/types.ts. */
export interface BrainSessionMetadata {
  sessionId: string;
  projectPath: string | null;
  gitBranch: string | null;
  models: string[];
  cliVersion: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  promptCount: number;
  proseCount: number;
  filesTouched: string[];
  terminalStatus: 'completed' | 'error' | 'unknown';
}

export interface BrainMcpStatus {
  registered: boolean;
  available: boolean;
}

/** Mirrors `CaptureMetadata` in daemon/services/brain/sources/types.ts. */
export interface BrainCaptureMetadata {
  capturedAt: string;
  project: string | null;
  cwd: string | null;
}

/** Mirrors `ArtifactMetadata` in daemon/services/brain/sources/types.ts. */
export interface BrainArtifactMetadata {
  repoPath: string;
  file: string;
}

/** Mirrors `ItemMetadata` in daemon/services/brain/sources/types.ts. */
export type BrainItemMetadata =
  | ({ kind: 'session' } & BrainSessionMetadata)
  | ({ kind: 'capture' } & BrainCaptureMetadata)
  | ({ kind: 'artifact' } & BrainArtifactMetadata);

/** Mirrors the backend `SourcePreview` in daemon/services/brain/registry.ts. */
export interface BrainSourcePreview {
  itemKey: string;
  prose: string;
  metadata: BrainItemMetadata | null;
  notePaths: string[];
  truncated: boolean;
  admitted: boolean;
  reason: string;
}

/** Mirrors `QueueCounts` in daemon/services/brain/queue.ts. */
export interface BrainQueueCounts {
  pending: number;
  running: number;
  done: number;
  failed: number;
}

/** Mirrors `QueueEntry` in daemon/services/brain/queue.ts. */
export interface BrainQueueEntry {
  id: number;
  accountId: number;
  sourceId: string;
  itemKey: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  error: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Mirrors the backend `IndexResult` in daemon/services/brain/registry.ts. */
export interface BrainIndexResult {
  itemKey: string;
  notesWritten: string[];
  skipped: boolean;
  reason: string;
}

/** Mirrors the backend `BrainRunPhase` in daemon/services/brain/registry.ts. */
export type BrainRunPhase =
  | 'preparing'
  | 'distilling'
  | 'extracting'
  | 'writing'
  | 'curating';

/** Mirrors the backend `BrainRun` in daemon/services/brain/registry.ts. */
export interface BrainRun {
  accountId: number;
  total: number;
  /** Items FINISHED, not started. */
  completed: number;
  item: string;
  label: string;
  phase: BrainRunPhase;
  /** Epoch ms when the current item started; restamped per item. */
  startedAt: number;
  written: number;
  skipped: number;
}

/** Mirrors the backend `RunResult` in daemon/services/brain/registry.ts. */
export interface BrainRunResult {
  written: number;
  skipped: number;
  /** One per item, in the order given. A throw arrives as a skip carrying it. */
  results: BrainIndexResult[];
}

/** Mirrors the backend `CurateResult` in daemon/services/brain/registry.ts. */
export interface BrainCurateResult {
  notePath: string;
  skipped: boolean;
  reason: string;
}

/** Mirrors the backend `VaultStats` in daemon/services/brain/stats.ts. */
export interface BrainVaultStats {
  noteCount: number;
  totalBytes: number;
  byType: Record<string, number>;
  medianBytes: number;
  largestBytes: number;
  largestNote: string | null;
  /** Derived from a bytes/4 ratio. Always label these as estimates in the UI. */
  estimatedTokens: { median: number; largest: number; vault: number };
  timelineBuckets: { label: string; count: number }[];
  spentUsd: number;
  qualifyingCount: number;
}

/** Mirrors the backend `NoteMeta` in daemon/services/brain/note-meta.ts. */
export interface BrainNoteMeta {
  relPath: string;
  title: string;
  type: BrainNoteType;
  project: string | null;
  created: string;
  updated: string;
  curatedAt: string | null;
}

/** Mirrors the backend `ParsedNote` in daemon/services/brain/types.ts. */
export interface BrainNote {
  frontmatter: {
    type: BrainNoteType;
    project?: string;
    aliases: string[];
    keywords: string[];
    created: string;
    updated: string;
    curated_at?: string;
    sources: string[];
  };
  body: string;
}

export const api = {
  async getHomeDirectory(): Promise<string> {
    try {
      return await apiCall<string>("get_home_directory");
    } catch (error) {
      console.error("Failed to get home directory:", error);
      return "/";
    }
  },

  async listProjects(): Promise<Project[]> {
    try {
      return await apiCall<Project[]>("list_projects");
    } catch (error) {
      console.error("Failed to list projects:", error);
      throw error;
    }
  },

  async setProjectPinned(projectPath: string, pinned: boolean): Promise<void> {
    try {
      await apiCall<null>('set_project_pinned', { projectPath, pinned });
    } catch (error) {
      console.error("Failed to set project pinned:", error);
      throw error;
    }
  },

  async createProject(path: string): Promise<Project> {
    try {
      return await apiCall<Project>('create_project', { path });
    } catch (error) {
      console.error("Failed to create project:", error);
      throw error;
    }
  },

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

  async deleteSession(
    sessionId: string,
    projectId: string,
    projectPath?: string,
  ): Promise<void> {
    const params: Record<string, string> = { sessionId, projectId };
    if (projectPath) params.projectPath = projectPath;
    await apiCall<unknown>('delete_session', params);
  },

  /** Bound to `accountId`, not path resolution, so it cannot cascade to a sibling account. */
  async deleteClaudeProject(args: {
    accountId: number;
    projectId: string;
  }): Promise<{ deletedPath: string }> {
    return apiCall<{ deletedPath: string }>('delete_project', {
      accountId: args.accountId,
      projectId: args.projectId,
    });
  },

  /** Not `getClaudeSettings().model`: an exported `ANTHROPIC_DEFAULT_MODEL` outranks the settings.json pin. */
  async getClaudeDefaultModel(opts?: { configDir?: string }): Promise<{
    model: string | null;
    source: 'ANTHROPIC_MODEL' | 'ANTHROPIC_DEFAULT_MODEL' | 'settings' | 'none';
  }> {
    const params: Record<string, unknown> = {};
    if (opts?.configDir) params.configDir = opts.configDir;
    const result = await apiCall<{
      model: string | null;
      source: 'ANTHROPIC_MODEL' | 'ANTHROPIC_DEFAULT_MODEL' | 'settings' | 'none';
    }>("get_claude_default_model", params);
    return result ?? { model: null, source: 'none' };
  },

  async getClaudeSettings(opts?: { projectPath?: string; configDir?: string }): Promise<ClaudeSettings> {
    try {
      const params: Record<string, unknown> = {};
      if (opts?.projectPath !== undefined) params.projectPath = opts.projectPath;
      if (opts?.configDir !== undefined) params.configDir = opts.configDir;
      const result = await apiCall<{ data: ClaudeSettings }>("get_claude_settings", params);

      if (result && typeof result === 'object' && 'data' in result) {
        return result.data;
      }

      return result;
    } catch (error) {
      console.error("Failed to get Claude settings:", error);
      throw error;
    }
  },

  async getSystemPrompt(): Promise<string> {
    try {
      return await apiCall<string>("get_system_prompt");
    } catch (error) {
      console.error("Failed to get system prompt:", error);
      throw error;
    }
  },

  async checkClaudeVersion(): Promise<ClaudeVersionStatus> {
    try {
      return await apiCall<ClaudeVersionStatus>("check_claude_version");
    } catch (error) {
      console.error("Failed to check Claude version:", error);
      throw error;
    }
  },

  async saveSystemPrompt(content: string): Promise<string> {
    try {
      return await apiCall<string>("save_system_prompt", { content });
    } catch (error) {
      console.error("Failed to save system prompt:", error);
      throw error;
    }
  },

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


  async readClaudeMdFile(filePath: string): Promise<string> {
    try {
      return await apiCall<string>("read_claude_md_file", { filePath });
    } catch (error) {
      console.error("Failed to read CLAUDE.md file:", error);
      throw error;
    }
  },

  async saveClaudeMdFile(filePath: string, content: string): Promise<string> {
    try {
      return await apiCall<string>("save_claude_md_file", { filePath, content });
    } catch (error) {
      console.error("Failed to save CLAUDE.md file:", error);
      throw error;
    }
  },


  async revealPathInFinder(path: string): Promise<void> {
    try {
      await apiCall<void>('reveal_path_in_finder', { path });
    } catch (error) {
      console.error("Failed to reveal path:", error);
      throw error;
    }
  },

  async loadSessionHistory(sessionId: string, projectId: string, projectPath?: string): Promise<any[]> {
    const params: Record<string, string> = { sessionId, projectId };
    if (projectPath) params.projectPath = projectPath;
    return apiCall("load_session_history", params);
  },

  async startSession(tabId: string, projectPath: string, model: string, permissionMode: string, resumeSessionId?: string, configDir?: string, effort?: string, manualAccountOverride?: boolean, agent?: AgentKind): Promise<void> {
    return apiCall("session_start", { tabId, projectPath, model, permissionMode, resumeSessionId, configDir, effort, manualAccountOverride, agent });
  },

  async sessionRebind(tabId: string): Promise<boolean> {
    return apiCall("session_rebind", { tabId });
  },

  async sendMessage(tabId: string, prompt: string): Promise<void> {
    return apiCall("session_send_message", { tabId, prompt });
  },

  async sendStructuredMessage(tabId: string, content: Record<string, unknown>[]): Promise<void> {
    return apiCall("session_send_structured_message", { tabId, content });
  },

  // Resolved by a FIFO queue, not by request id, so no requestId is sent.
  async respondPermission(tabId: string, behavior: string, updatedInput?: unknown, updatedPermissions?: unknown[]): Promise<void> {
    return apiCall("session_respond_permission", { tabId, behavior, updatedInput, updatedPermissions });
  },

  // Request-targeted: main drops an answer whose requestId is no longer at the queue head.
  async respondElicitation(tabId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>, requestId?: string): Promise<void> {
    return apiCall("session_respond_elicitation", {
      tabId,
      action,
      ...(content !== undefined && { content }),
      ...(requestId !== undefined && { requestId }),
    });
  },

  async stopSession(tabId: string): Promise<void> {
    return apiCall("session_stop", { tabId });
  },

  /** Unlike `stopSession`, ends the session only if no other client still has it open. */
  async releaseSession(tabId: string): Promise<void> {
    return apiCall("session_release", { tabId });
  },

  async getSessionInfo(tabId: string): Promise<unknown> {
    return apiCall("session_get_info", { tabId });
  },

  async sessionGetHealth(tabId: string): Promise<{
    alive: boolean;
    sessionId: string | null;
    sessionStatus: SessionStatus;
    turn: TurnState;
    /** Decides whether Bypass is reachable mid-session. */
    launchPermissionMode?: string | null;
    permissionMode?: string | null;
  }> {
    return apiCall("session_get_health", { tabId });
  },

  async sessionInterrupt(tabId: string): Promise<void> {
    return apiCall("session_interrupt", { tabId });
  },

  async sessionSetModel(tabId: string, model?: string): Promise<string | null> {
    return apiCall("session_set_model", { tabId, model });
  },

  async sessionSetTitle(tabId: string, title: string): Promise<boolean> {
    return apiCall("session_set_title", { tabId, title });
  },

  /** The answer arrives on `session-side-chat:<tabId>`. */
  async sessionSideChatAsk(tabId: string, question: string): Promise<SideChatAskResult> {
    return apiCall("session_side_chat_ask", { tabId, question });
  },

  async sessionSideChatClose(tabId: string): Promise<void> {
    return apiCall("session_side_chat_close", { tabId });
  },

  async sessionGetSideChat(tabId: string): Promise<SideChat> {
    return apiCall("session_get_side_chat", { tabId });
  },

  async sessionSuggestTitle(tabId: string, description: string): Promise<string | null> {
    return apiCall("session_suggest_title", { tabId, description });
  },

  async sessionSetPermissionMode(tabId: string, mode: string): Promise<string | null> {
    return apiCall("session_set_permission_mode", { tabId, mode });
  },

  async sessionSetEffort(tabId: string, level: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null): Promise<void> {
    return apiCall("session_set_effort", { tabId, level });
  },

  async sessionAccountInfo(tabId: string): Promise<SessionAccountInfo | null> {
    return apiCall("session_account_info", { tabId });
  },

  async readAccountIdentity(configDir: string): Promise<AccountIdentity | null> {
    return apiCall("account_identity_read", { configDir });
  },

  /** Costs a process spawn: explicit user action only. */
  async probeAccountAuthStatus(configDir: string): Promise<AccountAuthStatus | null> {
    return apiCall("account_identity_probe", { configDir });
  },

  async accountIdentityVerdict(configDir: string): Promise<IdentityVerdict | null> {
    return apiCall("account_identity_verdict", { configDir });
  },

  async accountLoginExpiry(configDir: string, refresh = false): Promise<LoginExpiry | null> {
    return apiCall("account_login_expiry", refresh ? { configDir, refresh } : { configDir });
  },

  subscribeAccountIdentity(
    configDir: string,
    cb: (verdict: IdentityVerdict) => void,
  ): () => void {
    return window.electronAPI.onEvent(
      "account-identity-changed",
      (...args: unknown[]) => {
        const payload = args[0] as
          | { configDir?: string; verdict?: IdentityVerdict }
          | undefined;
        if (payload?.configDir !== configDir || !payload.verdict) return;
        cb(payload.verdict);
      },
    );
  },

  async sessionContextUsage(tabId: string): Promise<SessionContextUsage | null> {
    return apiCall("session_context_usage", { tabId });
  },

  async sessionTaskOutput(tabId: string, taskId: string): Promise<TaskOutputTail | null> {
    return apiCall("session_get_task_output", { tabId, taskId });
  },

  async sessionPromptDraftActivity(tabId: string): Promise<void> {
    return apiCall("session_prompt_draft_activity", { tabId });
  },

  async sessionStopTask(tabId: string, taskId: string): Promise<void> {
    return apiCall("session_stop_task", { tabId, taskId });
  },

  async sessionBackgroundTask(tabId: string, toolUseId: string): Promise<boolean> {
    return apiCall("session_background_task", { tabId, toolUseId });
  },

  async sessionCliStatus(tabId: string): Promise<SessionStatusReport | null> {
    return apiCall("session_cli_status", { tabId });
  },

  async sessionSupportedCommands(tabId: string): Promise<SessionSlashCommand[]> {
    return apiCall("session_supported_commands", { tabId });
  },

  async sessionSupportedModels(tabId: string): Promise<SessionModelInfo[]> {
    return apiCall("session_supported_models", { tabId });
  },

  async listSupportedModels(configDir: string): Promise<SessionModelInfo[]> {
    return apiCall("list_supported_models", { configDir });
  },

  async refreshSupportedModels(configDir: string): Promise<SessionModelInfo[]> {
    return apiCall("refresh_supported_models", { configDir });
  },

  async listSupportedCommands(configDir: string): Promise<SessionSlashCommand[]> {
    return apiCall("list_supported_commands", { configDir });
  },

  async sessionMcpServerStatus(tabId: string): Promise<SessionMcpServerStatus[]> {
    return apiCall("session_mcp_server_status", { tabId });
  },

  async sessionMcpAuthenticate(tabId: string, serverName: string): Promise<McpAuthResult> {
    return apiCall("session_mcp_authenticate", { tabId, serverName });
  },

  async sessionMcpReauthenticate(tabId: string, serverName: string): Promise<McpAuthResult> {
    return apiCall("session_mcp_reauthenticate", { tabId, serverName });
  },

  async sessionMcpReconnect(tabId: string, serverName: string): Promise<void> {
    return apiCall("session_mcp_reconnect", { tabId, serverName });
  },

  async sessionMcpSubmitCallbackUrl(tabId: string, serverName: string, callbackUrl: string): Promise<void> {
    return apiCall("session_mcp_submit_callback_url", { tabId, serverName, callbackUrl });
  },

  async sessionMcpSetEnabled(tabId: string, serverName: string, enabled: boolean): Promise<void> {
    return apiCall("session_mcp_set_enabled", { tabId, serverName, enabled });
  },

  async sessionPlugins(tabId: string, force = false): Promise<SessionPluginInfo[]> {
    return apiCall("session_plugins", { tabId, force });
  },

  async getSubagentMeta(
    configDir: string,
    projectPath: string,
    sessionId: string,
  ): Promise<Record<string, SubagentMetaEntry>> {
    return apiCall("session_subagent_meta", { configDir, projectPath, sessionId });
  },

  async sessionCostWatch(
    configDir: string,
    projectPath: string,
    sessionId: string,
    accountName: string,
  ): Promise<SessionCostSnapshot | null> {
    return apiCall("session_cost_watch", { configDir, projectPath, sessionId, accountName });
  },

  async sessionCostUnwatch(sessionId: string): Promise<null> {
    return apiCall("session_cost_unwatch", { sessionId });
  },

  async sessionCostHistory(
    filters: CostHistoryFilterParams & { groupBy: 'day' | 'week' | 'month' },
  ): Promise<CostHistoryPeriod[]> {
    return apiCall("session_cost_history", stripUndefined(filters));
  },

  async sessionCostSessions(filters: CostHistoryFilterParams): Promise<CostSessionRow[]> {
    return apiCall("session_cost_sessions", stripUndefined(filters));
  },

  async sessionCostHistoryByModel(
    filters: CostHistoryFilterParams & { groupBy: 'day' | 'week' | 'month' },
  ): Promise<CostHistoryPeriodModel[]> {
    return apiCall("session_cost_history_by_model", stripUndefined(filters));
  },

  async sessionCostByProject(filters: CostHistoryFilterParams): Promise<CostByProject[]> {
    return apiCall("session_cost_by_project", stripUndefined(filters));
  },

  async sessionCostByModel(filters: CostHistoryFilterParams): Promise<CostByModel[]> {
    return apiCall("session_cost_by_model", stripUndefined(filters));
  },

  async sessionCostByProjectModel(filters: CostHistoryFilterParams): Promise<CostByProjectModel[]> {
    return apiCall("session_cost_by_project_model", stripUndefined(filters));
  },

  async sessionCostTotals(filters: CostHistoryFilterParams): Promise<CostTotals | null> {
    return apiCall("session_cost_totals", stripUndefined(filters));
  },

  async sessionCostComponents(filters: CostHistoryFilterParams): Promise<CostComponents | null> {
    return apiCall("session_cost_components", stripUndefined(filters));
  },

  async sessionCostCachingRoi(filters: CostHistoryFilterParams): Promise<CachingRoi | null> {
    return apiCall("session_cost_caching_roi", stripUndefined(filters));
  },

  async sessionCostSubagentSplit(filters: CostHistoryFilterParams): Promise<SubagentSplitRow[]> {
    return apiCall("session_cost_subagent_split", stripUndefined(filters));
  },

  async sessionCostUnpriced(filters: CostHistoryFilterParams): Promise<UnpricedModel[]> {
    return apiCall("session_cost_unpriced", stripUndefined(filters));
  },

  async sessionCostFacets(filters: CostHistoryFilterParams): Promise<CostFacets | null> {
    return apiCall("session_cost_facets", stripUndefined(filters));
  },

  /** Takes filter state, not query params: the export re-runs the queries in a hidden view at a print hash built here. */
  async costReportExportPdf(params: {
    filters: CostFilterState;
    savePath: string;
  }): Promise<{ path: string }> {
    return apiCall("cost_report_export_pdf", { ...params, hash: buildPrintHash(params.filters) });
  },

  async costReportPrintReady(metrics: PrintMeasurement): Promise<null> {
    return apiCall("cost_report_print_ready", metrics as unknown as Record<string, unknown>);
  },

  async modelPricingList(): Promise<ModelPricingRow[]> {
    return apiCall("model_pricing_list", {});
  },

  async modelPricingShipped(): Promise<ModelPricingInput[]> {
    return apiCall("model_pricing_shipped", {});
  },

  /** Rejects bad input rather than coercing; the message is user-facing. */
  async modelPricingUpsert(row: ModelPricingInput): Promise<ModelPricingRow> {
    return apiCall("model_pricing_upsert", stripUndefined({ ...row }));
  },

  async modelPricingDelete(id: number): Promise<void> {
    return apiCall("model_pricing_delete", { id });
  },

  async sessionCostRescan(): Promise<{ sessionsScanned: number } | null> {
    return apiCall("session_cost_rescan", {});
  },

  async sessionGetPermissions(tabId: string, projectPath: string, configDir: string): Promise<any[]> {
    return apiCall("session_get_permissions", { tabId, projectPath, configDir });
  },

  /** `null` means no answer, not no rules: keep showing the file view. */
  async sessionListPermissionRules(tabId: string): Promise<CliPermissionRulesState | null> {
    return apiCall("session_list_permission_rules", { tabId });
  },

  async sessionUpdatePermission(tabId: string, projectPath: string, configDir: string, update: {
    action: "add" | "remove";
    scope: string;
    behavior: "allow" | "deny";
    rule: string;
  }): Promise<void> {
    return apiCall("session_update_permission", { tabId, projectPath, configDir, ...update });
  },

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
      orderBy: filters.orderBy,
      orderDir: filters.orderDir,
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

  async listDirectoryContents(directoryPath: string): Promise<FileEntry[]> {
    return apiCall("list_directory_contents", { directoryPath });
  },

  async searchFiles(basePath: string, query: string): Promise<FileEntry[]> {
    return apiCall("search_files", { basePath, query });
  },

  async createDirectory(directoryPath: string): Promise<string> {
    return apiCall("create_directory", { directoryPath });
  },

  async dropPaths(): Promise<string[]> {
    return apiCall("drop:paths", {});
  },

  async saveDroppedFile(name: string, data: string): Promise<string> {
    return apiCall("save_dropped_file", { name, data });
  },

  async getUsageStats(): Promise<UsageStats> {
    try {
      return await apiCall<UsageStats>("get_usage_stats");
    } catch (error) {
      console.error("Failed to get usage stats:", error);
      throw error;
    }
  },

  async getUsageByDateRange(startDate: string, endDate: string): Promise<UsageStats> {
    try {
      return await apiCall<UsageStats>("get_usage_by_date_range", { startDate, endDate });
    } catch (error) {
      console.error("Failed to get usage by date range:", error);
      throw error;
    }
  },

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

  async getCliUsage(configDir?: string): Promise<string> {
    return apiCall("get_cli_usage", { configDir });
  },

  async getRateLimits(accountName?: string): Promise<RateLimitSnapshot[]> {
    return apiCall<RateLimitSnapshot[]>("get_rate_limits", { accountName });
  },

  async getRateLimitSettings(): Promise<RateLimitSettings> {
    return apiCall<RateLimitSettings>("get_rate_limit_settings");
  },

  async updateRateLimitSettings(
    partial: Partial<RateLimitSettings>,
  ): Promise<RateLimitSettings> {
    return apiCall<RateLimitSettings>("update_rate_limit_settings", partial);
  },

  async runUsageCli(accountName: string): Promise<UsageRunResult> {
    return apiCall<UsageRunResult>("usage_run_cli", { accountName });
  },

  async getLastUsageCli(accountName: string): Promise<UsageRunResult | null> {
    return apiCall<UsageRunResult | null>("usage_get_last", { accountName });
  },

  async validateCliPath(path: string | null): Promise<ValidateCliPathResult> {
    return apiCall<ValidateCliPathResult>("accounts_validate_cli_path", { path });
  },

  async mcpAdd(
    name: string,
    transport: string,
    command?: string,
    args: string[] = [],
    env: Record<string, string> = {},
    url?: string,
    scope = "local",
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

  async mcpList(configDir?: string): Promise<MCPServer[]> {
    try {
      const result = await apiCall<MCPServer[]>("mcp_list", { configDir });
      return result;
    } catch (error) {
      console.error("API: Failed to list MCP servers:", error);
      throw error;
    }
  },

  async mcpGet(name: string, configDir?: string): Promise<MCPServer> {
    try {
      return await apiCall<MCPServer>("mcp_get", { name, configDir });
    } catch (error) {
      console.error("Failed to get MCP server:", error);
      throw error;
    }
  },

  async mcpRemove(name: string, configDir?: string): Promise<string> {
    try {
      return await apiCall<string>("mcp_remove", { name, configDir });
    } catch (error) {
      console.error("Failed to remove MCP server:", error);
      throw error;
    }
  },

  async mcpAddJson(name: string, jsonConfig: string, scope = "local", configDir?: string): Promise<AddServerResult> {
    try {
      return await apiCall<AddServerResult>("mcp_add_json", { name, jsonConfig, scope, configDir });
    } catch (error) {
      console.error("Failed to add MCP server from JSON:", error);
      throw error;
    }
  },

  async mcpAddFromClaudeDesktop(scope = "local", configDir?: string): Promise<ImportResult> {
    try {
      return await apiCall<ImportResult>("mcp_add_from_claude_desktop", { scope, configDir });
    } catch (error) {
      console.error("Failed to import from Claude Desktop:", error);
      throw error;
    }
  },

  async mcpServe(): Promise<string> {
    try {
      return await apiCall<string>("mcp_serve");
    } catch (error) {
      console.error("Failed to start MCP server:", error);
      throw error;
    }
  },

  async mcpTestConnection(name: string, configDir?: string): Promise<string> {
    try {
      return await apiCall<string>("mcp_test_connection", { name, configDir });
    } catch (error) {
      console.error("Failed to test MCP connection:", error);
      throw error;
    }
  },

  async mcpResetProjectChoices(): Promise<string> {
    try {
      return await apiCall<string>("mcp_reset_project_choices");
    } catch (error) {
      console.error("Failed to reset project choices:", error);
      throw error;
    }
  },

  async mcpGetServerStatus(configDir?: string): Promise<Record<string, ServerStatus>> {
    try {
      return await apiCall<Record<string, ServerStatus>>("mcp_get_server_status", { configDir });
    } catch (error) {
      console.error("Failed to get server status:", error);
      throw error;
    }
  },

  async mcpReadProjectConfig(projectPath: string): Promise<MCPProjectConfig> {
    try {
      return await apiCall<MCPProjectConfig>("mcp_read_project_config", { projectPath });
    } catch (error) {
      console.error("Failed to read project MCP config:", error);
      throw error;
    }
  },

  async mcpSaveProjectConfig(projectPath: string, config: MCPProjectConfig): Promise<string> {
    try {
      return await apiCall<string>("mcp_save_project_config", { projectPath, config });
    } catch (error) {
      console.error("Failed to save project MCP config:", error);
      throw error;
    }
  },

  async getClaudeBinaryPath(): Promise<string | null> {
    try {
      return await apiCall<string | null>("get_claude_binary_path");
    } catch (error) {
      console.error("Failed to get Claude binary path:", error);
      throw error;
    }
  },

  async setClaudeBinaryPath(path: string): Promise<void> {
    try {
      await apiCall<void>("set_claude_binary_path", { path }); return;
    } catch (error) {
      console.error("Failed to set Claude binary path:", error);
      throw error;
    }
  },

  async listClaudeInstallations(): Promise<ClaudeInstallation[]> {
    try {
      return await apiCall<ClaudeInstallation[]>("list_claude_installations");
    } catch (error) {
      console.error("Failed to list Claude installations:", error);
      throw error;
    }
  },

  /** Null means no signal, not up to date. */
  async getClaudeCliReviewStatus(): Promise<CliReviewStatus | null> {
    try {
      return await apiCall<CliReviewStatus>("claude_cli_review_status");
    } catch (error) {
      console.error("Failed to read Claude CLI review status:", error);
      return null;
    }
  },

  /** Not caught like the status probe: a failure must reach the user. */
  async updateClaudeCli(): Promise<CliUpdateResult> {
    return await apiCall<CliUpdateResult>("claude_cli_update");
  },

  /** Only a Mac host claims: claiming from a web client would spend the announcement. */
  async notifyClaudeCliRelease(version: string): Promise<boolean> {
    if (!platform.isDesktop) return false;
    const won = await apiCall<boolean>("claude_cli_claim_update_notice", { version });
    if (!won) return false;
    return await platform.showNotification({
      id: `${CLI_RELEASE_NOTICE_ID_PREFIX}${version}`,
      title: `Claude Code ${version} is available`,
      body: 'Open Updates to install it.',
    });
  },

  async getGitBranch(projectPath: string): Promise<string | null> {
    return apiCall("get_git_branch", { projectPath });
  },

  async listGitWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
    const result = await apiCall<WorktreeInfo[]>("list_git_worktrees", { projectPath });
    return result ?? [];
  },

  async startSessionGitWatch(projectPath: string): Promise<{
    watchId: string;
    snapshot: SessionGitSnapshot;
  } | null> {
    return apiCall("start_session_git_watch", { projectPath });
  },

  async stopSessionGitWatch(watchId: string): Promise<void> {
    await apiCall("stop_session_git_watch", { watchId });
  },

  async setSessionGitWatchVisible(watchId: string, visible: boolean): Promise<void> {
    await apiCall("set_session_git_watch_visible", { watchId, visible });
  },

  async reconnectSessionGitWatch(watchId: string): Promise<SessionGitSnapshot | null> {
    return apiCall("reconnect_session_git_watch", { watchId });
  },

  onSessionGitChanged(
    watchId: string,
    callback: (snapshot: SessionGitSnapshot) => void,
  ): () => void {
    return window.electronAPI.onEvent(
      `session-git-changed:${watchId}`,
      (data: unknown) => {
        if (!isIpcRecord(data)) return;
        const repos: RepoSnapshot[] = Array.isArray(data.repos)
          ? (data.repos as unknown[]).map((item) => {
              const r = isIpcRecord(item) ? item : undefined;
              return {
                name: typeof r?.name === 'string' ? r.name : '',
                root: normalizePathSnapshot(r?.root, ''),
                worktrees: Array.isArray(r?.worktrees)
                  ? (r.worktrees as unknown[]).map((w) => normalizePathSnapshot(w, ''))
                  : [],
              };
            })
          : [];
        callback({ repos, foundCount: typeof data.foundCount === 'number' ? data.foundCount : 0 });
      },
    );
  },

  /** Pull-only: never put path lists on the per-tab watch's hot path. */
  async listGitChangedFiles(projectPath: string): Promise<GitChangedFile[]> {
    const result = await apiCall<GitChangedFile[]>("git_list_changed_files", { projectPath });
    return result ?? [];
  },

  async getGitFileDiff(
    projectPath: string,
    filePath: string,
    contextLines?: number,
  ): Promise<string> {
    const result = await apiCall<string>("git_file_diff", {
      projectPath,
      filePath,
      ...(contextLines === undefined ? {} : { contextLines }),
    });
    return result ?? "";
  },

  async limaCheckInstalled(): Promise<{ installed: boolean }> {
    return apiCall("lima_check_installed");
  },

  async limaListVms(): Promise<LimaVm[]> {
    const result = await apiCall<LimaVm[]>("lima_list_vms");
    return result ?? [];
  },

  async limaListContainers(vmName: string): Promise<LimaDockerContainer[]> {
    const result = await apiCall<LimaDockerContainer[]>("lima_list_containers", { vmName });
    return result ?? [];
  },

  async limaStartVm(vmName: string): Promise<void> {
    await apiCall("lima_start_vm", { vmName });
  },

  async limaStopVm(vmName: string): Promise<void> {
    await apiCall("lima_stop_vm", { vmName });
  },

  async limaStartContainer(vmName: string, containerId: string): Promise<void> {
    await apiCall("lima_start_container", { vmName, containerId });
  },

  async limaStopContainer(vmName: string, containerId: string): Promise<void> {
    await apiCall("lima_stop_container", { vmName, containerId });
  },

  async storageListTables(): Promise<any[]> {
    try {
      return await apiCall<any[]>("storage_list_tables");
    } catch (error) {
      console.error("Failed to list tables:", error);
      throw error;
    }
  },

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

  async storageUpdateRow(
    tableName: string,
    primaryKeyValues: Record<string, unknown>,
    updates: Record<string, unknown>
  ): Promise<void> {
    try {
      await apiCall<void>("storage_update_row", {
        tableName,
        primaryKeyValues,
        updates,
      }); return;
    } catch (error) {
      console.error("Failed to update row:", error);
      throw error;
    }
  },

  async storageDeleteRow(
    tableName: string,
    primaryKeyValues: Record<string, unknown>
  ): Promise<void> {
    try {
      await apiCall<void>("storage_delete_row", {
        tableName,
        primaryKeyValues,
      }); return;
    } catch (error) {
      console.error("Failed to delete row:", error);
      throw error;
    }
  },

  async storageInsertRow(
    tableName: string,
    values: Record<string, unknown>
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

  async storageExecuteSql(query: string): Promise<any> {
    try {
      return await apiCall<any>("storage_execute_sql", { query });
    } catch (error) {
      console.error("Failed to execute SQL:", error);
      throw error;
    }
  },

  async storageResetDatabase(): Promise<void> {
    try {
      await apiCall<void>("storage_reset_database"); return;
    } catch (error) {
      console.error("Failed to reset database:", error);
      throw error;
    }
  },

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

  async getProxySettings<T = unknown>(): Promise<T> {
    return apiCall<T>('get_proxy_settings');
  },

  async saveProxySettings(settings: unknown): Promise<void> {
    await apiCall('save_proxy_settings', { settings });
  },

  async previewNotificationSound(
    id: string,
  ): Promise<{ played: boolean; path: string | null }> {
    try {
      return await apiCall<{ played: boolean; path: string | null }>(
        'preview_notification_sound',
        { id },
      );
    } catch (error) {
      console.error(`Failed to preview notification sound ${id}:`, error);
      return { played: false, path: null };
    }
  },

  /** `configDir` is required for the user scope: never fall back to ~/.claude. */
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

  /** `configDir` is required for the user scope: never fall back to ~/.claude. */
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

  async validateHookCommand(command: string): Promise<{ valid: boolean; message: string }> {
    try {
      return await apiCall<{ valid: boolean; message: string }>("validate_hook_command", { command });
    } catch (error) {
      console.error("Failed to validate hook command:", error);
      throw error;
    }
  },

  /** `configDir` is required: never fall back to ~/.claude. */
  async getMergedHooksConfig(projectPath: string, configDir?: string): Promise<HooksConfiguration> {
    try {
      const [userHooks, projectHooks, localHooks] = await Promise.all([
        this.getHooksConfig('user', undefined, configDir),
        this.getHooksConfig('project', projectPath, configDir),
        this.getHooksConfig('local', projectPath, configDir)
      ]);

      const { HooksManager } = await import('@/lib/hooksManager');
      return HooksManager.mergeConfigs(userHooks, projectHooks, localHooks);
    } catch (error) {
      console.error("Failed to get merged hooks config:", error);
      throw error;
    }
  },

  async slashCommandsList(projectPath?: string, configDir?: string): Promise<SlashCommand[]> {
    try {
      return await apiCall<SlashCommand[]>("slash_commands_list", { projectPath, configDir });
    } catch (error) {
      console.error("Failed to list slash commands:", error);
      throw error;
    }
  },

  async slashCommandGet(commandId: string, configDir?: string): Promise<SlashCommand> {
    try {
      return await apiCall<SlashCommand>("slash_command_get", { commandId, configDir });
    } catch (error) {
      console.error("Failed to get slash command:", error);
      throw error;
    }
  },

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

  async slashCommandDelete(commandId: string, projectPath?: string, configDir?: string): Promise<string> {
    try {
      return await apiCall<string>("slash_command_delete", { commandId, projectPath, configDir });
    } catch (error) {
      console.error("Failed to delete slash command:", error);
      throw error;
    }
  },

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

  onSessionSummaryUpdated(
    callback: (payload: { sessionUuid: string }) => void,
  ): () => void {
    return window.electronAPI.onEvent(
      'session-summary:updated',
      (data: unknown) => {
        if (!isIpcRecord(data) || typeof data.sessionUuid !== 'string') return;
        callback({ sessionUuid: data.sessionUuid });
      },
    );
  },

  async getGeneratingSummaryUuids(): Promise<string[]> {
    const result = await apiCall<unknown>('summary_generating_now', {});
    if (!Array.isArray(result)) return [];
    return result.filter((x): x is string => typeof x === 'string');
  },

  onSessionSummaryGenerating(
    callback: (payload: { sessionUuid: string; generating: boolean }) => void,
  ): () => void {
    return window.electronAPI.onEvent(
      'session-summary:generating',
      (data: unknown) => {
        if (
          !isIpcRecord(data) ||
          typeof data.sessionUuid !== 'string' ||
          typeof data.generating !== 'boolean'
        ) {
          return;
        }
        callback({ sessionUuid: data.sessionUuid, generating: data.generating });
      },
    );
  },

  async listAccounts(): Promise<Account[]> {
    return apiCall<Account[]>('list_accounts');
  },

  async createAccount(opts: {
    name: string;
    configDir: string;
    engine: AccountEngine;
    subscriptionLabel?: string;
    hasCost?: boolean;
    color?: string;
    icon?: string;
    sessionDefaults?: SessionDefaults;
    cliPath?: string | null;
    expectedEmail?: string | null;
  }): Promise<Account> {
    const params: Record<string, unknown> = { name: opts.name, configDir: opts.configDir, engine: opts.engine };
    if (opts.subscriptionLabel !== undefined) params.subscriptionLabel = opts.subscriptionLabel;
    if (opts.hasCost !== undefined) params.hasCost = opts.hasCost;
    if (opts.color !== undefined) params.color = opts.color;
    if (opts.icon !== undefined) params.icon = opts.icon;
    if (opts.sessionDefaults !== undefined) params.sessionDefaults = opts.sessionDefaults;
    if (opts.cliPath !== undefined) params.cliPath = opts.cliPath;
    if (opts.expectedEmail !== undefined) params.expectedEmail = opts.expectedEmail;
    return apiCall<Account>('create_account', params);
  },

  async updateAccount(
    id: number,
    opts: {
      name: string;
      configDir: string;
      // engine omitted: immutable after create.
      subscriptionLabel?: string;
      hasCost?: boolean;
      color?: string;
      icon?: string;
      sessionDefaults?: SessionDefaults | null;
      cliPath?: string | null;
      /** undefined preserves, null clears, string sets. */
      expectedEmail?: string | null;
    },
  ): Promise<void> {
    const params: Record<string, unknown> = { id, name: opts.name, configDir: opts.configDir };
    if (opts.subscriptionLabel !== undefined) params.subscriptionLabel = opts.subscriptionLabel;
    if (opts.hasCost !== undefined) params.hasCost = opts.hasCost;
    if (opts.color !== undefined) params.color = opts.color;
    if (opts.icon !== undefined) params.icon = opts.icon;
    if (opts.sessionDefaults !== undefined) params.sessionDefaults = opts.sessionDefaults;
    if (opts.cliPath !== undefined) params.cliPath = opts.cliPath;
    if (opts.expectedEmail !== undefined) params.expectedEmail = opts.expectedEmail;
    return apiCall<void>('update_account', params);
  },

  async deleteAccount(id: number): Promise<void> {
    return apiCall<void>('delete_account', { id });
  },

  async listPathRules(): Promise<PathRule[]> {
    return apiCall<PathRule[]>('list_path_rules');
  },

  async addPathRule(accountId: number, pathPrefix: string, priority = 0): Promise<void> {
    return apiCall<void>('add_path_rule', { accountId, pathPrefix, priority });
  },

  async removePathRule(ruleId: number): Promise<void> {
    return apiCall<void>('remove_path_rule', { ruleId });
  },

  /** An all-null pair is an error, never a default-account fallback. */
  async resolveAccountForProject(projectPath: string): Promise<ResolvePair> {
    return apiCall<ResolvePair>('resolve_account_for_project', { projectPath });
  },

  async setProjectAccountOverride(projectPath: string, accountId: number): Promise<void> {
    return apiCall<void>('set_project_account_override', { projectPath, accountId });
  },

  async listProjectOverrides(): Promise<ProjectOverride[]> {
    return apiCall<ProjectOverride[]>('list_project_overrides');
  },

  async discoverAccounts(): Promise<DiscoveredConfigDir[]> {
    return apiCall<DiscoveredConfigDir[]>('discover_accounts');
  },

  async scanForNewAccounts(): Promise<Account[]> {
    return apiCall<Account[]>('scan_for_new_accounts');
  },

  async explainAccountResolution(projectPath: string, engine?: AgentKind): Promise<{
    account: Account;
    match_type: string;
    match_detail: string;
  } | null> {
    return apiCall("explain_account_resolution", engine ? { projectPath, engine } : { projectPath });
  },

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

  onSessionInFlightCount(cb: (count: number) => void): () => void {
    return window.electronAPI.onEvent(
      'session-inflight-count',
      (data: unknown) => { cb(isIpcRecord(data) && typeof data.count === 'number' ? data.count : 0); },
    );
  },

  onInstallStatus(
    cb: (data: {
      phase: 'waiting' | 'installing';
      activeSessions?: number;
      tabs?: { tabId: string; status: string }[];
    }) => void,
  ): () => void {
    return window.electronAPI.onEvent('updater:install-status', cb as (...args: unknown[]) => void);
  },

  onNotificationClicked(cb: (data: { tabId?: string | null; id?: string | null }) => void): () => void {
    return window.electronAPI.onEvent('notification-clicked', cb as (...args: unknown[]) => void);
  },

  onUpdateProgress(callback: (data: { percent: number; bytesDownloaded: number; totalBytes: number }) => void): () => void {
    return window.electronAPI.onEvent('updater:progress', callback as (...args: unknown[]) => void);
  },

  async publishTabStatus(summary: TabStatusSummary): Promise<void> {
    return apiCall('tab_status_publish', { summary });
  },

  async removeTabStatus(tabId: string): Promise<void> {
    return apiCall('tab_status_remove', { tabId });
  },

  async listTabStatuses(): Promise<TabStatusSummary[]> {
    return apiCall<TabStatusSummary[]>('tab_status_list', {});
  },

  /** Kills any turn in flight: ask the user first. */
  async restartDaemon(): Promise<{ url: string | null }> {
    return apiCall<{ url: string | null }>('remote:restart', {});
  },

  onTabStatusesChanged(cb: (summaries: TabStatusSummary[]) => void): () => void {
    return window.electronAPI.onEvent(
      'tab-status:changed',
      (data: unknown) => { cb(Array.isArray(data) ? (data as TabStatusSummary[]) : []); },
    );
  },

  async listBranchColors(repoPath: string): Promise<BranchColor[]> {
    return apiCall<BranchColor[]>('branch_colors_list', { repoPath });
  },
  async upsertBranchColor(input: { repoPath: string; branchName: string; color: string }): Promise<BranchColor> {
    return apiCall<BranchColor>('branch_colors_upsert', input);
  },
  async deleteBranchColor(id: number): Promise<boolean> {
    return apiCall<boolean>('branch_colors_delete', { id });
  },
  onBranchColorsChanged(cb: (repoPath: string) => void): () => void {
    return window.electronAPI.onEvent('branch-colors-changed', (data: unknown) => {
      if (isIpcRecord(data) && typeof data.repoPath === 'string') cb(data.repoPath);
    });
  },

  async listRepoAliases(repoPaths: string[]): Promise<Record<string, string>> {
    return (await apiCall<Record<string, string>>('repo_aliases_list', { repoPaths })) ?? {};
  },
  async setRepoAlias(repoPath: string, alias: string): Promise<void> {
    await apiCall('repo_alias_set', { repoPath, alias });
  },
  onRepoAliasesChanged(cb: () => void): () => void {
    return window.electronAPI.onEvent('repo-aliases-changed', () => { cb(); });
  },

  async getProjectRepos(projectPath: string): Promise<ProjectRepos | null> {
    return apiCall<ProjectRepos | null>('get_project_repos', { projectPath });
  },
  async setProjectRepoWatched(projectPath: string, repoPath: string, watched: boolean): Promise<void> {
    await apiCall('set_project_repo_watched', { projectPath, repoPath, watched });
  },
  async setProjectRepoScanDepth(projectPath: string, depth: number): Promise<void> {
    await apiCall('set_project_repo_scan_depth', { projectPath, depth });
  },
  async removeProjectRepo(projectPath: string, repoPath: string): Promise<void> {
    await apiCall('remove_project_repo', { projectPath, repoPath });
  },
  onProjectReposChanged(cb: (projectPath: string) => void): () => void {
    return window.electronAPI.onEvent('project-repos-changed', (data: unknown) => {
      if (isIpcRecord(data) && typeof data.projectPath === 'string') cb(data.projectPath);
    });
  },
  async listGitBranches(projectPath: string): Promise<string[]> {
    return apiCall<string[]>('git_list_branches', { projectPath });
  },

  async oneShotTerminalSpawn(opts: {
    binary: string;
    args: string[];
    env?: Record<string, string | undefined>;
    cwd?: string;
    cols?: number;
    rows?: number;
  }): Promise<{ ptyHandle: string }> {
    return apiCall<{ ptyHandle: string }>('one_shot_terminal_spawn', opts);
  },
  async oneShotTerminalWrite(ptyHandle: string, data: string): Promise<void> {
    return apiCall('one_shot_terminal_write', { ptyHandle, data });
  },
  async oneShotTerminalResize(ptyHandle: string, cols: number, rows: number): Promise<void> {
    return apiCall('one_shot_terminal_resize', { ptyHandle, cols, rows });
  },
  async oneShotTerminalKill(ptyHandle: string): Promise<void> {
    return apiCall('one_shot_terminal_kill', { ptyHandle });
  },

  async fsExists(filePath: string): Promise<{ exists: boolean }> {
    return apiCall<{ exists: boolean }>('fs_exists', { path: filePath });
  },

  async claudeSignInBegin(configDir: string): Promise<ClaudeSignInFlow> {
    return apiCall<ClaudeSignInFlow>('claude_auth_begin', { configDir });
  },
  async claudeSignInSubmitCode(flowId: string, code: string): Promise<ClaudeSignedInAccount> {
    return apiCall<ClaudeSignedInAccount>('claude_auth_submit_code', { flowId, code });
  },
  async claudeSignInWait(flowId: string): Promise<ClaudeSignedInAccount> {
    return apiCall<ClaudeSignedInAccount>('claude_auth_wait', { flowId });
  },
  async claudeSignInCancel(flowId: string): Promise<void> {
    return apiCall<void>('claude_auth_cancel', { flowId });
  },
  async claudeLogout(configDir: string): Promise<void> {
    return apiCall<void>('claude_auth_logout', { configDir });
  },

  async getCodexAuthStatus(configDir: string): Promise<CodexAuthStatus> {
    return apiCall<CodexAuthStatus>('codex_auth_status', { configDir });
  },
  async startCodexLoginFlow(opts: { configDir: string; codexBinaryPath?: string }): Promise<{ ptyHandle: string }> {
    const params: Record<string, unknown> = { configDir: opts.configDir };
    if (opts.codexBinaryPath) params.codexBinaryPath = opts.codexBinaryPath;
    return apiCall<{ ptyHandle: string }>('codex_auth_start_login', params);
  },
  async cancelCodexLoginFlow(ptyHandle: string): Promise<void> {
    return apiCall<void>('codex_auth_cancel_login', { ptyHandle });
  },
  async getCodexBinaryPath(): Promise<string | null> {
    return apiCall<string | null>('codex_binary_path', {});
  },
  async codexLogout(configDir: string): Promise<void> {
    return apiCall<void>('codex_logout', { configDir });
  },
  subscribeCodexAuthStatus(
    configDir: string,
    callback: (status: CodexAuthStatus) => void,
  ): () => void {
    return window.electronAPI.onEvent(
      'codex-auth-status-changed',
      (data: unknown) => {
        if (!isIpcRecord(data)) return;
        if (data.configDir !== configDir) return;
        const status = data.status;
        if (!isIpcRecord(status) || typeof status.authenticated !== 'boolean') return;
        callback({
          authenticated: status.authenticated,
          email: typeof status.email === 'string' ? status.email : undefined,
          mode: status.mode === 'oauth' || status.mode === 'apikey' ? status.mode : undefined,
        });
      },
    );
  },

  async listCodexSessions(): Promise<CodexSessionEntry[]> {
    return apiCall<CodexSessionEntry[]>('codex_session_list', {});
  },

  // Every Brain call takes an explicit accountId: a wrong default is a confidentiality failure.

  async brainVaultPath(accountId: number): Promise<string | null> {
    return apiCall<string | null>('brain_vault_path', { accountId });
  },

  async brainSetVaultPath(accountId: number, path: string): Promise<void> {
    return apiCall<void>('brain_set_vault_path', { accountId, path });
  },

  async brainClearVaultPath(accountId: number): Promise<void> {
    return apiCall<void>('brain_clear_vault_path', { accountId });
  },

  async brainSearch(
    accountId: number,
    query: string,
    opts: { type?: string; limit?: number } = {},
  ): Promise<BrainSearchHit[]> {
    return apiCall<BrainSearchHit[]>('brain_search', stripUndefined({
      accountId,
      query,
      type: opts.type,
      limit: opts.limit,
    }));
  },

  async brainListNoteMeta(accountId: number): Promise<BrainNoteMeta[]> {
    return apiCall<BrainNoteMeta[]>('brain_list_note_meta', { accountId });
  },

  async brainListNotes(accountId: number): Promise<string[]> {
    return apiCall<string[]>('brain_list_notes', { accountId });
  },

  async brainReadNote(accountId: number, notePath: string): Promise<BrainNote> {
    return apiCall<BrainNote>('brain_read_note', { accountId, notePath });
  },

  async brainStatus(accountId: number): Promise<BrainVaultStatus> {
    return apiCall<BrainVaultStatus>('brain_status', { accountId });
  },

  async brainDefaultVaultPath(accountName: string): Promise<string> {
    return apiCall<string>('brain_default_vault_path', { accountName });
  },

  async brainRebuild(accountId: number): Promise<number> {
    return apiCall<number>('brain_rebuild', { accountId });
  },

  async brainUpdateNote(accountId: number, notePath: string, body: string): Promise<BrainNote> {
    return apiCall<BrainNote>('brain_update_note', { accountId, notePath, body });
  },

  async brainDeleteNote(accountId: number, notePath: string): Promise<void> {
    return apiCall<void>('brain_delete_note', { accountId, notePath });
  },

  async brainEnqueueProjectSources(accountId: number, projectPath: string): Promise<number> {
    return apiCall<number>('brain_enqueue_project_sources', { accountId, projectPath });
  },

  async brainBacklinks(accountId: number, notePath: string): Promise<string[]> {
    return apiCall<string[]>('brain_backlinks', { accountId, notePath });
  },

  async brainMcpStatus(accountId: number): Promise<BrainMcpStatus> {
    return apiCall<BrainMcpStatus>('brain_mcp_status', { accountId });
  },

  async brainMcpRegister(accountId: number): Promise<void> {
    return apiCall<void>('brain_mcp_register', { accountId });
  },

  async brainMcpUnregister(accountId: number): Promise<void> {
    return apiCall<void>('brain_mcp_unregister', { accountId });
  },

  async brainListSources(
    accountId: number,
    opts: { includeExcluded?: boolean } = {},
  ): Promise<BrainSourceSummary[]> {
    return apiCall<BrainSourceSummary[]>('brain_list_sources', stripUndefined({
      accountId,
      includeExcluded: opts.includeExcluded,
    }));
  },

  /** Send every decision, not just exclusions: an absent key re-applies the scratch-path default. */
  async brainSetExcludedProjects(
    accountId: number,
    decisions: Record<string, boolean>,
  ): Promise<void> {
    return apiCall<void>('brain_set_excluded_projects', { accountId, decisions });
  },

  async brainSourcePreview(
    accountId: number,
    itemKey: string,
  ): Promise<BrainSourcePreview | null> {
    return apiCall<BrainSourcePreview | null>('brain_source_preview', { accountId, itemKey });
  },

  /** The renderer's only token-spending index path, so every spend has a run record. */
  async brainIndexSelection(
    accountId: number,
    itemKeys: string[],
    opts: { force?: boolean } = {},
  ): Promise<BrainRunResult> {
    // Deliberate press: index what the unattended gate would decline.
    return apiCall<BrainRunResult>('brain_index_selection', {
      accountId,
      itemKeys,
      ...(opts.force === true ? { force: true } : {}),
    });
  },

  async brainActiveRun(): Promise<BrainRun | null> {
    return apiCall<BrainRun | null>('brain_active_run', {});
  },

  async brainCurrentRun(accountId: number): Promise<BrainRun | null> {
    return apiCall<BrainRun | null>('brain_current_run', { accountId });
  },

  onBrainRunProgress(callback: (run: BrainRun | null) => void): () => void {
    return window.electronAPI.onEvent('brain-run-progress', (data: unknown) => {
      if (data === null || data === undefined) {
        callback(null);
        return;
      }
      if (typeof data !== 'object' || typeof (data as { total?: unknown }).total !== 'number') return;
      callback(data as BrainRun);
    });
  },

  async brainQueueCounts(accountId: number): Promise<BrainQueueCounts> {
    return apiCall<BrainQueueCounts>('brain_queue_counts', { accountId });
  },

  async brainQueueList(accountId: number, limit?: number): Promise<BrainQueueEntry[]> {
    return apiCall<BrainQueueEntry[]>('brain_queue_list', stripUndefined({ accountId, limit }));
  },

  async brainBackfill(accountId: number): Promise<number> {
    return apiCall<number>('brain_backfill', { accountId });
  },

  async brainCurateNote(accountId: number, notePath: string): Promise<BrainCurateResult> {
    return apiCall<BrainCurateResult>('brain_curate_note', { accountId, notePath });
  },

  async brainEnqueueCuration(accountId: number): Promise<number> {
    return apiCall<number>('brain_enqueue_curation', { accountId });
  },

  async brainStats(accountId: number): Promise<BrainVaultStats> {
    return apiCall<BrainVaultStats>('brain_stats', { accountId });
  },

  async brainQueueClear(accountId: number): Promise<void> {
    return apiCall<void>('brain_queue_clear', { accountId });
  },

};

/** Mirrors `CodexSessionEntry` in daemon/services/codex-session-walker.ts. */
export interface CodexSessionEntry {
  conversationId: string;
  projectPath: string | null;
  lastActivity: string;
  jsonlPath: string;
}
