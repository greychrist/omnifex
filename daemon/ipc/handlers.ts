import type { Database } from '../services/database';
import type { PermissionsIOService } from '../services/permissions-io';
import { validateCliPath } from '../services/cli-path-validator';
import { gitBinary } from '../services/git-binary';
import { execFileText } from '../services/util/exec-text';
import type { WatchHolder } from '../services/git-watcher';
import { createBrainHandlers, type BrainMcpHandlerDeps } from './brain-handlers';
import type { BrainService } from '../services/brain/registry';
import { claimCliUpdateNotice } from '../services/cli-update-notice';

export interface Services {
  brain?: BrainService;
  brainMcp?: BrainMcpHandlerDeps;
  accounts?: {
    list(): unknown;
    create(data: unknown): unknown;
    update(id: unknown, data: unknown): unknown;
    updateSummarySettings(data: unknown): unknown;
    delete(id: unknown): unknown;
    listPathRules(): unknown;
    addPathRule(rule: unknown): unknown;
    removePathRule(id: unknown): unknown;
    resolveForProject(projectPath: string): unknown;
    setProjectOverride(projectPath: string, accountId: unknown): unknown;
    listProjectOverrides(): unknown;
    discoverAccounts(): unknown;
    scanForNewAccounts(): unknown;
    explainResolution(projectPath: string, engine?: string): unknown;
    /** For the positive ownership check on a renderer-supplied configDir. */
    knownConfigDirs(): string[];
  };
  claude?: {
    listProjects(configDir?: string): unknown;
    createProject(data: unknown): unknown;
    getProjectSessions(projectId: string, projectPath?: string): unknown;
    loadSessionHistory(sessionId: string, projectId: string, projectPath?: string): unknown;
    deleteSession(sessionId: string, projectId: string, projectPath?: string): unknown;
    deleteProject(args: { accountId: number; projectId: string }): unknown;
    setProjectPinned(args: { projectPath: string; pinned: boolean }): unknown;
    getHomeDirectory(): unknown;
    getSettings(opts?: unknown): unknown;
    getDefaultModel(opts?: unknown): unknown;
    saveSettings(settings: unknown, opts?: unknown): unknown;
    getSystemPrompt(opts?: unknown): unknown;
    saveSystemPrompt(prompt: unknown, opts?: unknown): unknown;
    checkVersion(): unknown;
    readClaudeMdFile(filePath: string): unknown;
    saveClaudeMdFile(filePath: string, content: string): unknown;
    getHooksConfig(scope: string, opts?: unknown): unknown;
    updateHooksConfig(scope: string, config: unknown, opts?: unknown): unknown;
    validateHookCommand(command: string): unknown;
    getMergedHooksConfig(projectPath: string, opts?: unknown): unknown;
    getCliUsage(configDir?: string): unknown;
  };
  sessions?: {
    respondElicitation(tabId: string, action: string, content?: Record<string, unknown>, requestId?: string): unknown;
    getInfo(sessionId: string): unknown;
    getHealth(sessionId: string): {
      alive: boolean;
      sessionId: string | null;
      sessionStatus: string;
      turn: { status: 'idle' | 'running'; since: string | null };
      launchPermissionMode?: string | null;
      permissionMode?: string | null;
    };
    setModel(sessionId: string, model?: string): unknown;
    setTitle(sessionId: string, title: string): unknown;
    askSideQuestion(sessionId: string, question: string): unknown;
    closeSideChat(sessionId: string): unknown;
    getSideChat(sessionId: string): unknown;
    suggestTitle(sessionId: string, description: string): unknown;
    setPermissionMode(sessionId: string, mode: string): unknown;
    setEffort(sessionId: string, level: unknown): unknown;
    applyPermissions(sessionId: string, permissions: unknown): unknown;
    listPermissionRules(sessionId: string): Promise<unknown>;
    getAccountInfo(sessionId: string): unknown;
    getContextUsage(sessionId: string): unknown;
    getTaskOutput(sessionId: string, taskId: string): unknown;
    stopTask(sessionId: string, taskId: string): unknown;
    promptDraftActivity(sessionId: string): unknown;
    backgroundTask(sessionId: string, toolUseId: string): unknown;
    getCliStatus(sessionId: string): unknown;
    getSupportedCommands(sessionId: string): unknown;
    getSupportedModels(sessionId: string): unknown;
    getMcpServerStatus(sessionId: string): unknown;
    mcpAuthenticate(sessionId: string, serverName: string): unknown;
    mcpReauthenticate(sessionId: string, serverName: string): unknown;
    mcpSetEnabled(sessionId: string, serverName: string, enabled: boolean): unknown;
    mcpReconnect(sessionId: string, serverName: string): unknown;
    mcpSubmitCallbackUrl(sessionId: string, serverName: string, callbackUrl: string): unknown;
    getPlugins(sessionId: string, force?: boolean): unknown;
    getSubagentMeta(args: { configDir: string; projectPath: string; sessionId: string }): unknown;
  };
  cost?: {
    get(args: { configDir: string; projectPath: string; sessionId: string; accountName: string }): unknown;
    watch(args: { configDir: string; projectPath: string; sessionId: string; accountName: string }): unknown;
    unwatch(sessionId: string): unknown;
    history(filters: Record<string, unknown>): unknown;
    historyByModel(filters: Record<string, unknown>): unknown;
    sessions(filters: Record<string, unknown>): unknown;
    byProject(filters: Record<string, unknown>): unknown;
    byModel(filters: Record<string, unknown>): unknown;
    byProjectModel(filters: Record<string, unknown>): unknown;
    components(filters: Record<string, unknown>): unknown;
    totals(filters: Record<string, unknown>): unknown;
    cachingRoi(filters: Record<string, unknown>): unknown;
    subagentSplit(filters: Record<string, unknown>): unknown;
    unpriced(filters: Record<string, unknown>): unknown;
    facets(filters: Record<string, unknown>): unknown;
    rescan(): unknown;
  };
  modelPricing?: {
    list(): unknown;
    upsert(input: unknown): unknown;
    remove(id: number): unknown;
    shipped(): unknown;
  };
  usage?: {
    getStats(params?: unknown): unknown;
    getByDateRange(params: unknown): unknown;
    getSessionStats(params?: unknown): unknown;
    getDetails(params?: unknown): unknown;
    getStatsByAccount(params?: unknown): unknown;
  };
  rateLimits?: {
    getSnapshots(): unknown;
    getSnapshotsByAccount(accountName: string): unknown;
    getSettings(): unknown;
    updateSettings(partial: unknown): unknown;
  };
  usageRunner?: {
    run(accountName: string): unknown;
    getLast(accountName: string): unknown;
  };
  claudeBinary?: {
    getPath(): unknown;
    setPath(path: string): unknown;
    listInstallations(): unknown;
    reviewStatus(): unknown;
    runUpdate(): unknown;
  };
  mcp?: {
    add(data: unknown): unknown;
    list(configDir?: string): unknown;
    get(name: string, configDir?: string): unknown;
    remove(name: string, configDir?: string): unknown;
    addJson(data: unknown): unknown;
    addFromClaudeDesktop(scope?: string, configDir?: string): unknown;
    serve(): unknown;
    testConnection(name: string, configDir?: string): unknown;
    resetProjectChoices(): unknown;
    getServerStatus(configDir?: string): unknown;
    readProjectConfig(projectPath: string): unknown;
    saveProjectConfig(projectPath: string, config: unknown): unknown;
  };
  slashCommands?: {
    list(projectPath?: string, configDir?: string): unknown;
    get(commandId: string, configDir?: string): unknown;
    save(data: unknown): unknown;
    delete(commandId: string, projectPath?: string, configDir?: string): unknown;
  };
  sessionsSummary?: {
    getSummary(
      sessionUuid: string,
      projectPath: string,
      configDir: string | null,
    ): unknown;
    generateSummary(
      sessionUuid: string,
      projectPath: string,
      configDir: string | null,
    ): Promise<unknown>;
    getGeneratingSessionUuids(): string[];
  };
  logging?: {
    writeBatch(entries: unknown): unknown;
    query(params: unknown): unknown;
    count(params: unknown): unknown;
    prune(olderThan?: string): unknown;
  };
  database?: Database;
  proxy?: {
    getSettings(): unknown;
    saveSettings(data: unknown): unknown;
  };
  permissionsIO?: PermissionsIOService;
  models?: {
    listSupported(configDir: string): unknown;
    refresh(configDir: string): unknown;
  };
  commands?: {
    listSupported(configDir: string): unknown;
  };
  gitWatcher?: {
    listWorktrees(projectPath: string): Promise<{ path: string; branch: string | null }[]>;
    startSession(projectPath: string, holder: WatchHolder | undefined): Promise<{
      watchId: string;
      snapshot: import('../services/git-watcher').SessionGitSnapshot;
    }>;
    reconnectSession(watchId: string, holder: WatchHolder | undefined): Promise<import('../services/git-watcher').SessionGitSnapshot | null>;
    stopSession(watchId: string): void;
    setSessionVisible(watchId: string, visible: boolean, holder: WatchHolder | undefined): void;
  };
  branchColors?: {
    listForRepo(repoPath: string): unknown;
    upsert(input: { repo_path: string; branch_name: string; color: string }): unknown;
    delete(id: number): unknown;
  };
  repoAliases?: {
    list(repoPaths: string[]): Record<string, string>;
    set(repoPath: string, alias: string): void;
  };
  projectRepos?: {
    get(projectPath: string): Promise<unknown>;
    setWatched(projectPath: string, repoPath: string, watched: boolean): void;
    setScanDepth(projectPath: string, depth: number): void;
    remove(projectPath: string, repoPath: string): void;
  };
  gitBranches?: {
    list(projectPath: string): Promise<string[]>;
  };
  gitDiff?: {
    listChangedFiles(projectPath: string): Promise<import('../services/git-diff').ChangedFile[]>;
    readFileDiff(
      projectPath: string,
      filePath: string,
      opts: import('../services/git-diff').ReadFileDiffOptions,
    ): Promise<string>;
  };
  lima?: {
    isInstalled(): Promise<boolean>;
    listVms(): Promise<unknown[]>;
    listContainers(vmName: string): Promise<unknown[]>;
    startVm(vmName: string): Promise<void>;
    stopVm(vmName: string): Promise<void>;
    startContainer(vmName: string, containerId: string): Promise<void>;
    stopContainer(vmName: string, containerId: string): Promise<void>;
  };
  filesystem?: {
    listDirectoryContents(directoryPath: string): Promise<unknown[]>;
    searchFiles(basePath: string, query: string): Promise<unknown[]>;
    createDirectory(directoryPath: string): Promise<string>;
    saveDroppedFile(name: string, base64: string): Promise<string>;
  };
  oneShotTerminal?: {
    spawn(opts: {
      binary: string;
      args: string[];
      env?: Record<string, string | undefined>;
      cwd?: string;
      cols?: number;
      rows?: number;
    }): { ptyHandle: string };
    write(ptyHandle: string, data: string): void;
    resize(ptyHandle: string, cols: number, rows: number): void;
    kill(ptyHandle: string): void;
  };
  codexAuth?: {
    getStatus(configDir: string): Promise<{
      authenticated: boolean;
      email?: string;
      mode?: 'oauth' | 'apikey';
    }>;
    startLoginFlow(opts: { configDir: string; codexBinaryPath?: string }): Promise<{ ptyHandle: string }>;
    cancelLoginFlow(ptyHandle: string): void;
    getBinaryPath(): string | null;
    logout(configDir: string): Promise<void>;
  };
  claudeAuth?: {
    beginSignIn(configDir: string): Promise<unknown>;
    submitCode(flowId: string, code: string): Promise<unknown>;
    waitForCompletion(flowId: string): Promise<unknown>;
    cancel(flowId: string): Promise<void>;
    logout(configDir: string): Promise<void>;
  };
  codexSessionWalker?: {
    listSessions(): Promise<import('../services/codex-session-walker').CodexSessionEntry[]>;
  };
  /** `probe` spawns the CLI: explicit user action only. */
  accountIdentity?: {
    read(configDir: string): import('../services/account-identity').OauthIdentity | null;
    probe(configDir: string): Promise<import('../services/account-identity').AuthStatus>;
    verdict(configDir: string): import('../services/account-identity').IdentityVerdict;
    loginExpiry(
      configDir: string,
      opts?: { refresh?: boolean },
    ): Promise<import('../services/login-expiry').LoginExpiry | null>;
  };
  /** Dev daemon only: a compromised renderer must never run raw SQL against the live database. */
  allowRawSql?: boolean;
}

function assertSafeIdentifier(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${String(name)}`);
  }
}

type HandlerFn = (event: unknown, params?: Record<string, unknown>) => Promise<unknown>;

// rpc.invoke error replies carry only the message, so the code rides as a `[CODE]` prefix api.ts parses back.
function repackageError(err: unknown): Error {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    const message = typeof code === 'string' && code.length > 0
      ? `[${code}] ${err.message}`
      : err.message;
    const out = new Error(message);
    out.stack = err.stack;
    return out;
  }
  return new Error(String(err));
}

function wrap(fn: () => unknown): HandlerFn {
  return async (_event: unknown, _params?: Record<string, unknown>) => {
    try {
      return await fn();
    } catch (err) {
      throw repackageError(err);
    }
  };
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- API surface stability — generic param documents intent.
function wrapWith<P>(fn: (params: P, event: unknown) => unknown): HandlerFn {
  return async (event: unknown, params?: Record<string, unknown>) => {
    try {
      return await fn(params as unknown as P, event);
    } catch (err) {
      throw repackageError(err);
    }
  };
}

function watchHolderOf(event: unknown): WatchHolder | undefined {
  const onClose = (event as { onClose?: unknown } | null)?.onClose;
  return typeof onClose === 'function' ? (event as WatchHolder) : undefined;
}

function costFilters(p: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    startDate: p?.startDate ?? p?.start_date,
    endDate: p?.endDate ?? p?.end_date,
    accountName: p?.accountName ?? p?.account_name,
    projectPath: p?.projectPath ?? p?.project_path,
    model: p?.model,
    isSubagent: p?.isSubagent ?? p?.is_subagent,
  };
}

export function getHandlerMap(services: Services = {}): Record<string, HandlerFn> {
  const { brain, brainMcp, accounts, claude, sessions, cost, modelPricing, usage, rateLimits, usageRunner, claudeBinary, mcp, slashCommands, sessionsSummary, logging, database, proxy, permissionsIO, models, commands, gitWatcher, branchColors, projectRepos, repoAliases, gitBranches, gitDiff, lima, filesystem, oneShotTerminal, codexAuth, claudeAuth, codexSessionWalker, accountIdentity, allowRawSql } = services;

  // A renderer-supplied configDir must belong to a known account, so a stale tab can't write into another account's config.
  const normalizeDir = (dir: string): string => dir.replace(/\/+$/, '');
  function assertOwnedConfigDir(configDir: unknown): void {
    if (typeof configDir !== 'string' || configDir.length === 0) return;
    let known: string[];
    try {
      known = accounts?.knownConfigDirs?.() ?? [];
    } catch {
      return;
    }
    if (known.length === 0) return;
    const set = new Set(known.map(normalizeDir));
    if (!set.has(normalizeDir(configDir))) {
      throw new Error(`configDir does not belong to a known account: ${configDir}`);
    }
  }

  const map: Record<string, HandlerFn> = {
    // Spread first so an existing channel wins any name collision.
    ...createBrainHandlers(brain, brainMcp),

    list_accounts: wrap(() => accounts?.list() ?? null),
    create_account: wrapWith((p: Record<string, unknown>) => accounts?.create(p) ?? null),
    update_account: wrapWith((p: Record<string, unknown>) => accounts?.update(p?.id, p) ?? null),
    update_account_summary: wrapWith((p: Record<string, unknown>) => accounts?.updateSummarySettings(p) ?? null),
    delete_account: wrapWith((p: Record<string, unknown>) => accounts?.delete(p?.id) ?? null),
    list_path_rules: wrap(() => accounts?.listPathRules() ?? null),
    add_path_rule: wrapWith((p: Record<string, unknown>) => accounts?.addPathRule(p) ?? null),
    remove_path_rule: wrapWith((p: Record<string, unknown>) => accounts?.removePathRule(p?.ruleId ?? p?.id) ?? null),
    resolve_account_for_project: wrapWith((p: Record<string, unknown>) => accounts?.resolveForProject((p?.projectPath ?? p?.project_path) as string) ?? null),
    set_project_account_override: wrapWith((p: Record<string, unknown>) => accounts?.setProjectOverride((p?.projectPath ?? p?.project_path) as string, p?.accountId ?? p?.account_id) ?? null),
    list_project_overrides: wrap(() => accounts?.listProjectOverrides() ?? null),
    discover_accounts: wrap(() => accounts?.discoverAccounts() ?? null),
    scan_for_new_accounts: wrap(() => accounts?.scanForNewAccounts() ?? null),
    explain_account_resolution: wrapWith((p: Record<string, unknown>) => accounts?.explainResolution((p?.projectPath ?? p?.project_path) as string, p?.engine as string | undefined) ?? null),

    list_projects: wrapWith((p: Record<string, unknown>) => claude?.listProjects(p?.config_dir as string | undefined) ?? null),
    create_project: wrapWith((p: Record<string, unknown>) => claude?.createProject(p) ?? null),
    get_project_sessions: wrapWith((p: Record<string, unknown>) => claude?.getProjectSessions((p?.projectId ?? p?.project_id) as string, (p?.projectPath ?? p?.project_path) as string | undefined) ?? null),
    load_session_history: wrapWith((p: Record<string, unknown>) => claude?.loadSessionHistory((p?.sessionId ?? p?.session_id) as string, (p?.projectId ?? p?.project_id) as string, (p?.projectPath ?? p?.project_path) as string | undefined) ?? null),
    delete_session: wrapWith((p: Record<string, unknown>) => claude?.deleteSession((p?.sessionId ?? p?.session_id) as string, (p?.projectId ?? p?.project_id) as string, (p?.projectPath ?? p?.project_path) as string | undefined) ?? null),
    delete_project: wrapWith((p: Record<string, unknown>) => {
      const accountId = Number(p?.accountId ?? p?.account_id);
      const projectId = (p?.projectId ?? p?.project_id) as string;
      if (!Number.isFinite(accountId)) {
        throw new Error('delete_project: accountId is required');
      }
      return claude?.deleteProject({ accountId, projectId }) ?? null;
    }),
    set_project_pinned: wrapWith((p: Record<string, unknown>) => {
      const projectPath = (p?.projectPath ?? p?.project_path) as string;
      if (!projectPath) {
        throw new Error('set_project_pinned: projectPath is required');
      }
      return claude?.setProjectPinned({ projectPath, pinned: p?.pinned === true }) ?? null;
    }),
    get_home_directory: wrap(() => claude?.getHomeDirectory() ?? null),
    get_claude_settings: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      return claude?.getSettings(configDir ? { configDir } : undefined) ?? null;
    }),
    get_claude_default_model: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      return claude?.getDefaultModel(configDir ? { configDir } : undefined) ?? null;
    }),
    save_claude_settings: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      assertOwnedConfigDir(configDir);
      const settings = p?.settings ?? p;
      return claude?.saveSettings(settings, configDir ? { configDir } : undefined) ?? null;
    }),
    get_system_prompt: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      return claude?.getSystemPrompt(configDir ? { configDir } : undefined) ?? null;
    }),
    save_system_prompt: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      assertOwnedConfigDir(configDir);
      return claude?.saveSystemPrompt(p?.content ?? p?.prompt, configDir ? { configDir } : undefined) ?? null;
    }),
    check_claude_version: wrap(() => claude?.checkVersion() ?? null),
    read_claude_md_file: wrapWith((p: Record<string, unknown>) => claude?.readClaudeMdFile((p?.filePath ?? p?.file_path) as string) ?? null),
    save_claude_md_file: wrapWith((p: Record<string, unknown>) => claude?.saveClaudeMdFile((p?.filePath ?? p?.file_path) as string, p?.content as string) ?? null),
    get_hooks_config: wrapWith((p: Record<string, unknown>) => {
      const scope = (p?.scope as string) || 'user';
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      const projectPath = (p?.projectPath ?? p?.project_path) as string | undefined;
      return claude?.getHooksConfig(scope, { configDir, projectPath }) ?? null;
    }),
    update_hooks_config: wrapWith((p: Record<string, unknown>) => {
      const scope = (p?.scope as string) || 'user';
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      const projectPath = (p?.projectPath ?? p?.project_path) as string | undefined;
      // Project-scope hooks write under projectPath, so only account-global targets are guarded.
      if (scope !== 'project') assertOwnedConfigDir(configDir);
      const hooks = p?.hooks ?? p?.config ?? p;
      return claude?.updateHooksConfig(scope, hooks, { configDir, projectPath }) ?? null;
    }),
    validate_hook_command: wrapWith((p: Record<string, unknown>) => claude?.validateHookCommand(p?.command as string) ?? null),
    get_merged_hooks_config: wrapWith((p: Record<string, unknown>) => {
      const projectPath = (p?.projectPath ?? p?.project_path) as string ?? '';
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      return claude?.getMergedHooksConfig(projectPath, configDir ? { configDir } : undefined) ?? null;
    }),
    get_cli_usage: wrapWith((p: Record<string, unknown>) => claude?.getCliUsage((p?.configDir ?? p?.config_dir) as string | undefined) ?? null),

    session_respond_elicitation: wrapWith((p: Record<string, unknown>) => sessions?.respondElicitation((p?.tabId ?? p?.tab_id) as string, (p?.action) as string, p?.content as Record<string, unknown> | undefined, (p?.requestId ?? p?.request_id) as string | undefined) ?? null),
    session_get_info: wrapWith((p: Record<string, unknown>) => sessions?.getInfo((p?.tabId ?? p?.session_id) as string) ?? null),
    session_get_health: wrapWith((p: Record<string, unknown>) => sessions?.getHealth((p?.tabId ?? p?.session_id) as string) ?? { alive: false, sessionId: null, sessionStatus: 'stopped', turn: { status: 'idle', since: null }, launchPermissionMode: null, permissionMode: null }),
    session_set_model: wrapWith((p: Record<string, unknown>) => sessions?.setModel((p?.tabId ?? p?.session_id) as string, p?.model as string | undefined) ?? null),
    session_set_title: wrapWith((p: Record<string, unknown>) => sessions?.setTitle((p?.tabId ?? p?.session_id) as string, (p?.title ?? '') as string) ?? null),
    session_side_chat_ask: wrapWith((p: Record<string, unknown>) => sessions?.askSideQuestion((p?.tabId ?? p?.tab_id) as string, (p?.question ?? '') as string) ?? { ok: false, error: 'No live session' }),
    session_side_chat_close: wrapWith((p: Record<string, unknown>) => sessions?.closeSideChat((p?.tabId ?? p?.tab_id) as string) ?? null),
    session_get_side_chat: wrapWith((p: Record<string, unknown>) => sessions?.getSideChat((p?.tabId ?? p?.tab_id) as string) ?? { exchanges: [] }),
    session_suggest_title: wrapWith((p: Record<string, unknown>) => sessions?.suggestTitle((p?.tabId ?? p?.session_id) as string, (p?.description ?? '') as string) ?? null),
    session_set_permission_mode: wrapWith((p: Record<string, unknown>) => sessions?.setPermissionMode((p?.tabId ?? p?.session_id) as string, (p?.mode ?? p?.permissionMode) as string) ?? null),
    session_set_effort: wrapWith((p: Record<string, unknown>) => sessions?.setEffort((p?.tabId ?? p?.session_id) as string, p?.level ?? p?.effort) ?? null),
    session_account_info: wrapWith((p: Record<string, unknown>) => sessions?.getAccountInfo((p?.tabId ?? p?.session_id) as string) ?? null),
    session_context_usage: wrapWith((p: Record<string, unknown>) => sessions?.getContextUsage((p?.tabId ?? p?.session_id) as string) ?? null),
    session_get_task_output: wrapWith((p: Record<string, unknown>) => sessions?.getTaskOutput((p?.tabId ?? p?.session_id) as string, (p?.taskId ?? p?.task_id) as string) ?? null),
    session_prompt_draft_activity: wrapWith((p: Record<string, unknown>) => sessions?.promptDraftActivity((p?.tabId ?? p?.session_id) as string) ?? null),
    session_stop_task: wrapWith((p: Record<string, unknown>) => sessions?.stopTask((p?.tabId ?? p?.session_id) as string, (p?.taskId ?? p?.task_id) as string) ?? null),
    session_background_task: wrapWith((p: Record<string, unknown>) => sessions?.backgroundTask((p?.tabId ?? p?.session_id) as string, (p?.toolUseId ?? p?.tool_use_id) as string) ?? null),
    session_cli_status: wrapWith((p: Record<string, unknown>) => sessions?.getCliStatus((p?.tabId ?? p?.session_id) as string) ?? null),
    session_supported_commands: wrapWith((p: Record<string, unknown>) => sessions?.getSupportedCommands((p?.tabId ?? p?.session_id) as string) ?? null),
    session_supported_models: wrapWith((p: Record<string, unknown>) => sessions?.getSupportedModels((p?.tabId ?? p?.session_id) as string) ?? null),
    session_mcp_server_status: wrapWith((p: Record<string, unknown>) => sessions?.getMcpServerStatus((p?.tabId ?? p?.session_id) as string) ?? null),
    session_mcp_authenticate: wrapWith((p: Record<string, unknown>) => sessions?.mcpAuthenticate((p?.tabId ?? p?.session_id) as string, (p?.serverName ?? p?.server_name) as string) ?? null),
    session_mcp_reauthenticate: wrapWith((p: Record<string, unknown>) => sessions?.mcpReauthenticate((p?.tabId ?? p?.session_id) as string, (p?.serverName ?? p?.server_name) as string) ?? null),
    session_mcp_set_enabled: wrapWith((p: Record<string, unknown>) => sessions?.mcpSetEnabled((p?.tabId ?? p?.session_id) as string, (p?.serverName ?? p?.server_name) as string, p?.enabled as boolean) ?? null),
    session_mcp_reconnect: wrapWith((p: Record<string, unknown>) => sessions?.mcpReconnect((p?.tabId ?? p?.session_id) as string, (p?.serverName ?? p?.server_name) as string) ?? null),
    session_mcp_submit_callback_url: wrapWith((p: Record<string, unknown>) => sessions?.mcpSubmitCallbackUrl((p?.tabId ?? p?.session_id) as string, (p?.serverName ?? p?.server_name) as string, (p?.callbackUrl ?? p?.callback_url) as string) ?? null),
    session_plugins: wrapWith((p: Record<string, unknown>) => sessions?.getPlugins((p?.tabId ?? p?.session_id) as string, Boolean(p?.force)) ?? null),
    session_subagent_meta: wrapWith((p: Record<string, unknown>) => sessions?.getSubagentMeta({
      configDir: (p?.configDir ?? p?.config_dir) as string,
      projectPath: (p?.projectPath ?? p?.project_path) as string,
      sessionId: (p?.sessionId ?? p?.session_id) as string,
    }) ?? null),

    session_cost_get: wrapWith((p: Record<string, unknown>) => cost?.get({
      configDir: (p?.configDir ?? p?.config_dir) as string,
      projectPath: (p?.projectPath ?? p?.project_path) as string,
      sessionId: (p?.sessionId ?? p?.session_id) as string,
      accountName: (p?.accountName ?? p?.account_name) as string,
    }) ?? null),
    session_cost_watch: wrapWith((p: Record<string, unknown>) => cost?.watch({
      configDir: (p?.configDir ?? p?.config_dir) as string,
      projectPath: (p?.projectPath ?? p?.project_path) as string,
      sessionId: (p?.sessionId ?? p?.session_id) as string,
      accountName: (p?.accountName ?? p?.account_name) as string,
    }) ?? null),
    session_cost_unwatch: wrapWith((p: Record<string, unknown>) => {
      cost?.unwatch((p?.sessionId ?? p?.session_id) as string);
      return null;
    }),
    session_cost_history: wrapWith((p: Record<string, unknown>) => cost?.history({
      ...costFilters(p),
      groupBy: p?.groupBy ?? p?.group_by,
    }) ?? []),
    session_cost_sessions: wrapWith((p: Record<string, unknown>) => cost?.sessions(costFilters(p)) ?? []),
    session_cost_rescan: wrapWith(() => cost?.rescan() ?? null),

    session_cost_history_by_model: wrapWith((p: Record<string, unknown>) => cost?.historyByModel({
      ...costFilters(p),
      groupBy: p?.groupBy ?? p?.group_by,
    }) ?? []),
    session_cost_by_project: wrapWith((p: Record<string, unknown>) => cost?.byProject(costFilters(p)) ?? []),
    session_cost_by_model: wrapWith((p: Record<string, unknown>) => cost?.byModel(costFilters(p)) ?? []),
    session_cost_by_project_model: wrapWith((p: Record<string, unknown>) => cost?.byProjectModel(costFilters(p)) ?? []),
    session_cost_components: wrapWith((p: Record<string, unknown>) => cost?.components(costFilters(p)) ?? null),
    session_cost_totals: wrapWith((p: Record<string, unknown>) => cost?.totals(costFilters(p)) ?? null),
    session_cost_caching_roi: wrapWith((p: Record<string, unknown>) => cost?.cachingRoi(costFilters(p)) ?? null),
    session_cost_subagent_split: wrapWith((p: Record<string, unknown>) => cost?.subagentSplit(costFilters(p)) ?? []),
    session_cost_unpriced: wrapWith((p: Record<string, unknown>) => cost?.unpriced(costFilters(p)) ?? []),
    session_cost_facets: wrapWith((p: Record<string, unknown>) => cost?.facets(costFilters(p)) ?? null),

    // Pricing writes throw on bad input, never coerce: a wrong number that looks right is the worst cost-report bug.
    model_pricing_list: wrapWith(() => modelPricing?.list() ?? []),
    model_pricing_shipped: wrapWith(() => modelPricing?.shipped() ?? []),
    model_pricing_upsert: wrapWith((p: Record<string, unknown>) => modelPricing?.upsert({
      pattern: p?.pattern,
      effectiveFrom: p?.effectiveFrom ?? p?.effective_from,
      inputPerM: p?.inputPerM ?? p?.input_per_m,
      outputPerM: p?.outputPerM ?? p?.output_per_m,
      fastInputPerM: p?.fastInputPerM ?? p?.fast_input_per_m,
      fastOutputPerM: p?.fastOutputPerM ?? p?.fast_output_per_m,
      cacheReadPerM: p?.cacheReadPerM ?? p?.cache_read_per_m,
      cacheWrite5mPerM: p?.cacheWrite5mPerM ?? p?.cache_write_5m_per_m,
      cacheWrite1hPerM: p?.cacheWrite1hPerM ?? p?.cache_write_1h_per_m,
      label: p?.label,
      contextWindow: p?.contextWindow ?? p?.context_window,
    }) ?? null),
    model_pricing_delete: wrapWith((p: Record<string, unknown>) => {
      modelPricing?.remove(Number(p?.id));
      return null;
    }),

    list_supported_models: wrapWith((p: Record<string, unknown>) => models?.listSupported((p?.configDir ?? p?.config_dir) as string) ?? []),
    refresh_supported_models: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string;
      if (!configDir) throw new Error('configDir is required');
      if (!models) throw new Error('models service unavailable');
      return models.refresh(configDir);
    }),
    list_supported_commands: wrapWith((p: Record<string, unknown>) => commands?.listSupported((p?.configDir ?? p?.config_dir) as string) ?? []),

    // Null on a CLI too old to answer; the caller keeps the file view.
    session_list_permission_rules: wrapWith((p: Record<string, unknown>) => {
      const tabId = (p?.tabId ?? p?.session_id) as string | undefined;
      if (!tabId) return null;
      return sessions?.listPermissionRules(tabId) ?? null;
    }),

    session_get_permissions: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir ?? '') as string;
      const projectPath = (p?.projectPath ?? p?.project_path) as string | undefined;
      return permissionsIO?.getPermissions(configDir, projectPath) ?? null;
    }),

    session_update_permission: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      const projectPath = (p?.projectPath ?? p?.project_path) as string | undefined;
      const tabId = (p?.tabId ?? p?.session_id) as string | undefined;

      if (p?.scope !== 'project') assertOwnedConfigDir(configDir);

      permissionsIO?.updatePermission({
        configDir,
        projectPath,
        scope: p?.scope as 'user' | 'project' | 'local',
        action: p?.action as 'add' | 'remove',
        behavior: p?.behavior as 'allow' | 'deny',
        rule: p?.rule as string,
      });

      // apply_flag_settings REPLACES the flag layer's permissions, so send the full merged lists.
      if (tabId && configDir && sessions && permissionsIO) {
        try {
          const levels = permissionsIO.getPermissions(configDir, projectPath);
          const allow = Array.from(new Set(levels.flatMap((l) => l.allow)));
          const deny = Array.from(new Set(levels.flatMap((l) => l.deny)));
          void sessions.applyPermissions(tabId, { allow, deny });
        } catch (err) {
          console.error('[handlers] applyPermissions push failed:', err);
        }
      }

      return null;
    }),


    get_usage_stats: wrapWith((p: Record<string, unknown>) => usage?.getStats(p) ?? null),
    get_usage_by_date_range: wrapWith((p: Record<string, unknown>) => usage?.getByDateRange(p) ?? null),
    get_session_stats: wrapWith((p: Record<string, unknown>) => usage?.getSessionStats(p) ?? null),
    get_usage_details: wrapWith((p: Record<string, unknown>) => usage?.getDetails(p) ?? null),
    get_usage_by_account: wrapWith((p: Record<string, unknown>) => usage?.getStatsByAccount(p) ?? null),

    get_rate_limits: wrapWith((p: Record<string, unknown>) => {
      const accountName = (p?.accountName ?? p?.account_name) as string | undefined;
      if (accountName) return rateLimits?.getSnapshotsByAccount(accountName) ?? [];
      return rateLimits?.getSnapshots() ?? [];
    }),
    get_rate_limit_settings: wrap(() => rateLimits?.getSettings() ?? null),
    update_rate_limit_settings: wrapWith((p: Record<string, unknown>) => rateLimits?.updateSettings(p) ?? null),

    usage_run_cli: wrapWith((p: Record<string, unknown>) =>
      usageRunner?.run((p?.accountName ?? p?.account_name) as string) ?? null,
    ),
    usage_get_last: wrapWith((p: Record<string, unknown>) =>
      usageRunner?.getLast((p?.accountName ?? p?.account_name) as string) ?? null,
    ),
    accounts_validate_cli_path: wrapWith((p: Record<string, unknown>) =>
      validateCliPath(((p?.path ?? p?.cli_path) as string | null | undefined) ?? null),
    ),
    account_identity_read: wrapWith((p: Record<string, unknown>) =>
      accountIdentity?.read((p?.configDir ?? p?.config_dir) as string) ?? null,
    ),
    account_identity_probe: wrapWith((p: Record<string, unknown>) =>
      accountIdentity?.probe((p?.configDir ?? p?.config_dir) as string) ?? null,
    ),
    account_identity_verdict: wrapWith((p: Record<string, unknown>) =>
      accountIdentity?.verdict((p?.configDir ?? p?.config_dir) as string) ?? null,
    ),
    account_login_expiry: wrapWith((p: Record<string, unknown>) =>
      accountIdentity?.loginExpiry((p?.configDir ?? p?.config_dir) as string, { refresh: p?.refresh === true }) ?? null,
    ),

    get_claude_binary_path: wrap(() => claudeBinary?.getPath() ?? null),
    set_claude_binary_path: wrapWith((p: Record<string, unknown>) => claudeBinary?.setPath(p?.path as string) ?? null),
    list_claude_installations: wrap(() => claudeBinary?.listInstallations() ?? null),
    claude_cli_review_status: wrap(() => claudeBinary?.reviewStatus() ?? null),
    claude_cli_update: wrap(() => claudeBinary?.runUpdate() ?? null),
    claude_cli_claim_update_notice: wrapWith((p: Record<string, unknown>) =>
      database ? claimCliUpdateNotice(database, String((p?.version as string | number | undefined) ?? '')) : false),

    mcp_add: wrapWith((p: Record<string, unknown>) => { assertOwnedConfigDir(p?.configDir ?? p?.config_dir); return mcp?.add(p) ?? null; }),
    mcp_list: wrapWith((p: Record<string, unknown>) => mcp?.list((p?.configDir ?? p?.config_dir) as string | undefined) ?? null),
    mcp_get: wrapWith((p: Record<string, unknown>) => mcp?.get(p?.name as string, (p?.configDir ?? p?.config_dir) as string | undefined) ?? null),
    mcp_remove: wrapWith((p: Record<string, unknown>) => { assertOwnedConfigDir(p?.configDir ?? p?.config_dir); return mcp?.remove(p?.name as string, (p?.configDir ?? p?.config_dir) as string | undefined) ?? null; }),
    mcp_add_json: wrapWith((p: Record<string, unknown>) => { assertOwnedConfigDir(p?.configDir ?? p?.config_dir); return mcp?.addJson(p) ?? null; }),
    mcp_add_from_claude_desktop: wrapWith((p: Record<string, unknown>) => { assertOwnedConfigDir(p?.configDir ?? p?.config_dir); return mcp?.addFromClaudeDesktop(p?.scope as string | undefined, (p?.configDir ?? p?.config_dir) as string | undefined) ?? null; }),
    mcp_serve: wrapWith((_p: Record<string, unknown>) => mcp?.serve() ?? null),
    mcp_test_connection: wrapWith((p: Record<string, unknown>) => mcp?.testConnection(p?.name as string, (p?.configDir ?? p?.config_dir) as string | undefined) ?? null),
    mcp_reset_project_choices: wrap(() => mcp?.resetProjectChoices() ?? null),
    mcp_get_server_status: wrapWith((p: Record<string, unknown>) => mcp?.getServerStatus((p?.configDir ?? p?.config_dir) as string | undefined) ?? null),
    mcp_read_project_config: wrapWith((p: Record<string, unknown>) => mcp?.readProjectConfig((p?.projectPath ?? p?.project_path) as string) ?? null),
    mcp_save_project_config: wrapWith((p: Record<string, unknown>) => mcp?.saveProjectConfig((p?.projectPath ?? p?.project_path) as string, p?.config) ?? null),

    slash_commands_list: wrapWith((p: Record<string, unknown>) => slashCommands?.list(
      (p?.projectPath ?? p?.project_path) as string | undefined,
      (p?.configDir ?? p?.config_dir) as string | undefined,
    ) ?? null),
    slash_command_get: wrapWith((p: Record<string, unknown>) => slashCommands?.get(
      (p?.commandId ?? p?.command_id) as string,
      (p?.configDir ?? p?.config_dir) as string | undefined,
    ) ?? null),
    slash_command_save: wrapWith((p: Record<string, unknown>) => { assertOwnedConfigDir(p?.configDir ?? p?.config_dir); return slashCommands?.save(p) ?? null; }),
    slash_command_delete: wrapWith((p: Record<string, unknown>) => {
      assertOwnedConfigDir(p?.configDir ?? p?.config_dir);
      return slashCommands?.delete(
        (p?.commandId ?? p?.command_id) as string,
        (p?.projectPath ?? p?.project_path) as string | undefined,
        (p?.configDir ?? p?.config_dir) as string | undefined,
      ) ?? null;
    }),

    summary_get: wrapWith((p: Record<string, unknown>) => sessionsSummary?.getSummary(
      (p?.sessionUuid ?? p?.session_uuid) as string,
      (p?.projectPath ?? p?.project_path) as string,
      ((p?.configDir ?? p?.config_dir) as string | null | undefined) ?? null,
    ) ?? null),
    summary_generate: wrapWith((p: Record<string, unknown>) => sessionsSummary?.generateSummary(
      (p?.sessionUuid ?? p?.session_uuid) as string,
      (p?.projectPath ?? p?.project_path) as string,
      ((p?.configDir ?? p?.config_dir) as string | null | undefined) ?? null,
    ) ?? null),
    summary_generating_now: wrap(() => sessionsSummary?.getGeneratingSessionUuids() ?? []),

    log_write_batch: wrapWith((p: Record<string, unknown>) => logging?.writeBatch(p?.entries) ?? null),
    log_query: wrapWith((p: Record<string, unknown>) => logging?.query(p) ?? null),
    log_count: wrapWith((p: Record<string, unknown>) => logging?.count(p) ?? null),
    log_prune: wrapWith((p: Record<string, unknown>) => logging?.prune(p?.olderThan as string | undefined) ?? null),

    storage_list_tables: wrap(() => {
      if (!database) return null;
      const rows = database.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      return rows;
    }),
    storage_read_table: wrapWith((p: Record<string, unknown>) => {
      if (!database) return null;
      const table = (p?.tableName ?? p?.table_name) as string;
      const page = (p?.page as number) || 1;
      const pageSize = (p?.pageSize as number) || 50;
      if (!table) return { table_name: '', rows: [], columns: [], total_rows: 0, page, page_size: pageSize, total_pages: 1 };
      const offset = (page - 1) * pageSize;
      const searchQuery = p?.searchQuery as string | undefined;

      try {
        assertSafeIdentifier(table);
        const colInfo = database.raw.prepare(`PRAGMA table_info("${table}")`).all() as {
          cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
        }[];
        const columns = colInfo.map(c => ({
          cid: c.cid,
          name: c.name,
          type_name: c.type,
          notnull: !!c.notnull,
          dflt_value: c.dflt_value,
          pk: !!c.pk,
        }));

        let whereClause = '';
        const params: unknown[] = [];
        if (searchQuery) {
          const textCols = colInfo.filter(c => c.type.includes('TEXT') || c.type === '');
          if (textCols.length > 0) {
            whereClause = 'WHERE ' + textCols.map(c => `"${c.name}" LIKE ?`).join(' OR ');
            params.push(...textCols.map(() => `%${searchQuery}%`));
          }
        }

        const countRow = database.raw.prepare(`SELECT COUNT(*) as cnt FROM "${table}" ${whereClause}`).get(...params) as { cnt: number };
        const total_rows = countRow.cnt;
        const total_pages = Math.max(1, Math.ceil(total_rows / pageSize));
        const rows = database.raw.prepare(`SELECT * FROM "${table}" ${whereClause} LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
        return { table_name: table, rows, columns, total_rows, page, page_size: pageSize, total_pages };
      } catch (err) {
        return { table_name: table, rows: [], columns: [], total_rows: 0, page, page_size: pageSize, total_pages: 1, error: String(err) };
      }
    }),
    storage_update_row: wrapWith((p: Record<string, unknown>) => {
      if (!database) return null;
      const table = (p?.tableName ?? p?.table_name) as string;
      const primaryKeyValues = p?.primaryKeyValues as Record<string, unknown>;
      const updates = p?.updates as Record<string, unknown>;
      if (!table || !primaryKeyValues || !updates) return null;
      assertSafeIdentifier(table);
      [...Object.keys(updates), ...Object.keys(primaryKeyValues)].forEach(assertSafeIdentifier);
      const sets = Object.keys(updates).map(k => `"${k}" = ?`).join(', ');
      const wheres = Object.keys(primaryKeyValues).map(k => `"${k}" = ?`).join(' AND ');
      const values = [...Object.values(updates), ...Object.values(primaryKeyValues)];
      return database.raw.prepare(`UPDATE "${table}" SET ${sets} WHERE ${wheres}`).run(...values);
    }),
    storage_delete_row: wrapWith((p: Record<string, unknown>) => {
      if (!database) return null;
      const table = (p?.tableName ?? p?.table_name) as string;
      const primaryKeyValues = p?.primaryKeyValues as Record<string, unknown>;
      if (!table || !primaryKeyValues) return null;
      assertSafeIdentifier(table);
      Object.keys(primaryKeyValues).forEach(assertSafeIdentifier);
      const wheres = Object.keys(primaryKeyValues).map(k => `"${k}" = ?`).join(' AND ');
      return database.raw.prepare(`DELETE FROM "${table}" WHERE ${wheres}`).run(...Object.values(primaryKeyValues));
    }),
    storage_insert_row: wrapWith((p: Record<string, unknown>) => {
      if (!database) return null;
      const table = (p?.tableName ?? p?.table_name) as string;
      const values = (p?.values ?? p?.data) as Record<string, unknown>;
      if (!table || !values) return null;
      assertSafeIdentifier(table);
      Object.keys(values).forEach(assertSafeIdentifier);
      const cols = Object.keys(values).map(k => `"${k}"`).join(', ');
      const placeholders = Object.keys(values).map(() => '?').join(', ');
      return database.raw.prepare(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`).run(...Object.values(values));
    }),
    storage_execute_sql: wrapWith((p: Record<string, unknown>) => {
      if (!database) return null;
      if (!allowRawSql) {
        throw new Error('Raw SQL execution is disabled in this build');
      }
      const sql = (p?.query ?? p?.sql) as string;
      if (!sql) return null;
      return database.raw.prepare(sql).all();
    }),
    storage_reset_database: wrap(() => null),
    get_setting: wrapWith((p: Record<string, unknown>) => database?.getSetting(p?.key as string) ?? null),
    save_setting: wrapWith((p: Record<string, unknown>) => {
      database?.saveSetting(p?.key as string, p?.value as string);
      return null;
    }),

    get_git_branch: wrapWith(async (p: Record<string, unknown>) => {
      const projectPath = (p?.projectPath ?? p?.project_path) as string;
      if (!projectPath) return null;
      try {
        // Async with a timeout: a sync spawn froze every session's stream, and a wedged git froze it forever.
        return (await execFileText(gitBinary(), ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath, timeout: 5000 })).trim();
      } catch { return null; }
    }),

    get_proxy_settings: wrap(() => proxy?.getSettings() ?? null),
    save_proxy_settings: wrapWith((p: Record<string, unknown>) => proxy?.saveSettings(p) ?? null),

    list_git_worktrees: wrapWith(async (p: Record<string, unknown>) => {
      const projectPath = (p?.projectPath ?? p?.project_path) as string;
      if (!projectPath || !gitWatcher) return [];
      return gitWatcher.listWorktrees(projectPath);
    }),
    start_session_git_watch: wrapWith(async (p: Record<string, unknown>, event) => {
      const projectPath = (p?.projectPath ?? p?.project_path) as string;
      if (!projectPath || !gitWatcher) return null;
      return gitWatcher.startSession(projectPath, watchHolderOf(event));
    }),
    stop_session_git_watch: wrapWith(async (p: Record<string, unknown>) => {
      const watchId = (p?.watchId ?? p?.watch_id) as string;
      if (!watchId || !gitWatcher) return null;
      gitWatcher.stopSession(watchId);
      return null;
    }),
    set_session_git_watch_visible: wrapWith(async (p: Record<string, unknown>, event) => {
      const watchId = (p?.watchId ?? p?.watch_id) as string;
      if (!watchId || !gitWatcher) return null;
      gitWatcher.setSessionVisible(watchId, p?.visible !== false, watchHolderOf(event));
      return null;
    }),
    reconnect_session_git_watch: wrapWith(async (p: Record<string, unknown>, event) => {
      const watchId = (p?.watchId ?? p?.watch_id) as string;
      if (!watchId || !gitWatcher) return null;
      return gitWatcher.reconnectSession(watchId, watchHolderOf(event));
    }),

    branch_colors_list: wrapWith((p: Record<string, unknown>) =>
      branchColors?.listForRepo((p?.repoPath ?? p?.repo_path) as string) ?? [],
    ),
    branch_colors_upsert: wrapWith((p: Record<string, unknown>) =>
      branchColors?.upsert({
        repo_path: (p?.repoPath ?? p?.repo_path) as string,
        branch_name: (p?.branchName ?? p?.branch_name) as string,
        color: p?.color as string,
      }) ?? null,
    ),
    branch_colors_delete: wrapWith((p: Record<string, unknown>) =>
      branchColors?.delete(p?.id as number) ?? false,
    ),

    repo_aliases_list: wrapWith((p: Record<string, unknown>) => {
      const paths = (p?.repoPaths ?? p?.repo_paths);
      return repoAliases?.list(Array.isArray(paths) ? paths.filter((x): x is string => typeof x === 'string') : []) ?? {};
    }),
    repo_alias_set: wrapWith((p: Record<string, unknown>) => {
      repoAliases?.set((p?.repoPath ?? p?.repo_path) as string, typeof p?.alias === 'string' ? p.alias : '');
      return null;
    }),

    get_project_repos: wrapWith(async (p: Record<string, unknown>) =>
      (await projectRepos?.get((p?.projectPath ?? p?.project_path) as string)) ?? null,
    ),
    set_project_repo_watched: wrapWith((p: Record<string, unknown>) => {
      projectRepos?.setWatched(
        (p?.projectPath ?? p?.project_path) as string,
        (p?.repoPath ?? p?.repo_path) as string,
        p?.watched === true,
      );
      return null;
    }),
    set_project_repo_scan_depth: wrapWith((p: Record<string, unknown>) => {
      projectRepos?.setScanDepth((p?.projectPath ?? p?.project_path) as string, Number(p?.depth));
      return null;
    }),
    remove_project_repo: wrapWith((p: Record<string, unknown>) => {
      projectRepos?.remove(
        (p?.projectPath ?? p?.project_path) as string,
        (p?.repoPath ?? p?.repo_path) as string,
      );
      return null;
    }),

    git_list_branches: wrapWith((p: Record<string, unknown>) =>
      gitBranches?.list((p?.projectPath ?? p?.project_path) as string) ?? [],
    ),

    git_list_changed_files: wrapWith(async (p: Record<string, unknown>) => {
      const projectPath = (p?.projectPath ?? p?.project_path) as string;
      if (!projectPath || !gitDiff) return [];
      return gitDiff.listChangedFiles(projectPath);
    }),
    git_file_diff: wrapWith(async (p: Record<string, unknown>) => {
      const projectPath = (p?.projectPath ?? p?.project_path) as string;
      const filePath = (p?.filePath ?? p?.file_path) as string;
      if (!projectPath || !filePath || !gitDiff) return '';
      // Drop a non-numeric contextLines: `-UNaN` fails the whole git read.
      const rawContext = p?.contextLines ?? p?.context_lines;
      const contextLines = typeof rawContext === 'number' && Number.isFinite(rawContext)
        ? rawContext
        : undefined;
      try {
        return await gitDiff.readFileDiff(
          projectPath,
          filePath,
          contextLines === undefined ? {} : { contextLines },
        );
      } catch {
        // Never reject: this backs an auxiliary panel, and an empty patch is the honest render.
        return '';
      }
    }),

    lima_check_installed: wrap(async () => {
      if (!lima) return { installed: false };
      return { installed: await lima.isInstalled() };
    }),
    lima_list_vms: wrap(() => lima?.listVms() ?? []),
    lima_list_containers: wrapWith(async (p: Record<string, unknown>) => {
      const vmName = (p?.vmName ?? p?.vm_name) as string;
      if (!vmName || !lima) return [];
      return lima.listContainers(vmName);
    }),
    lima_start_vm: wrapWith(async (p: Record<string, unknown>) => {
      const vmName = (p?.vmName ?? p?.vm_name) as string;
      if (!vmName || !lima) return null;
      await lima.startVm(vmName);
      return null;
    }),
    lima_stop_vm: wrapWith(async (p: Record<string, unknown>) => {
      const vmName = (p?.vmName ?? p?.vm_name) as string;
      if (!vmName || !lima) return null;
      await lima.stopVm(vmName);
      return null;
    }),
    lima_start_container: wrapWith(async (p: Record<string, unknown>) => {
      const vmName = (p?.vmName ?? p?.vm_name) as string;
      const containerId = (p?.containerId ?? p?.container_id) as string;
      if (!vmName || !containerId || !lima) return null;
      await lima.startContainer(vmName, containerId);
      return null;
    }),
    lima_stop_container: wrapWith(async (p: Record<string, unknown>) => {
      const vmName = (p?.vmName ?? p?.vm_name) as string;
      const containerId = (p?.containerId ?? p?.container_id) as string;
      if (!vmName || !containerId || !lima) return null;
      await lima.stopContainer(vmName, containerId);
      return null;
    }),

    list_directory_contents: wrapWith((p: Record<string, unknown>) => {
      const directoryPath = (p?.directoryPath ?? p?.directory_path) as string;
      if (!directoryPath) throw new Error('directoryPath is required');
      return filesystem?.listDirectoryContents(directoryPath) ?? [];
    }),
    search_files: wrapWith((p: Record<string, unknown>) => {
      const basePath = (p?.basePath ?? p?.base_path) as string;
      const query = (p?.query as string) ?? '';
      if (!basePath) throw new Error('basePath is required');
      return filesystem?.searchFiles(basePath, query) ?? [];
    }),
    create_directory: wrapWith((p: Record<string, unknown>) => {
      const directoryPath = (p?.directoryPath ?? p?.directory_path) as string;
      if (!directoryPath) throw new Error('directoryPath is required');
      if (!filesystem) throw new Error('filesystem service unavailable');
      return filesystem.createDirectory(directoryPath);
    }),
    save_dropped_file: wrapWith((p: Record<string, unknown>) => {
      const name = p?.name as string;
      const data = p?.data as string;
      if (!name) throw new Error('name is required');
      if (!data) throw new Error('data is required');
      if (!filesystem) throw new Error('filesystem service unavailable');
      return filesystem.saveDroppedFile(name, data);
    }),
    fs_exists: wrapWith((p: Record<string, unknown>) => {
      const filePath = (p?.path ?? p?.filePath ?? p?.file_path) as string;
      if (!filePath) return { exists: false };
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy load; only used by the OneShotTerminal watcher poll.
      const fs = require('node:fs') as typeof import('node:fs');
      try {
        return { exists: fs.existsSync(filePath) };
      } catch {
        return { exists: false };
      }
    }),

    one_shot_terminal_spawn: wrapWith((p: Record<string, unknown>) => {
      const binary = p?.binary as string;
      const args = (p?.args as string[]) ?? [];
      const env = p?.env as Record<string, string | undefined> | undefined;
      const cwd = p?.cwd as string | undefined;
      const cols = p?.cols as number | undefined;
      const rows = p?.rows as number | undefined;
      if (!binary) throw new Error('one_shot_terminal_spawn: binary is required');
      return oneShotTerminal?.spawn({ binary, args, env, cwd, cols, rows }) ?? null;
    }),
    one_shot_terminal_write: wrapWith((p: Record<string, unknown>) => {
      const ptyHandle = (p?.ptyHandle ?? p?.pty_handle) as string;
      const data = p?.data as string;
      if (!ptyHandle) throw new Error('one_shot_terminal_write: ptyHandle is required');
      oneShotTerminal?.write(ptyHandle, data ?? '');
      return null;
    }),
    one_shot_terminal_resize: wrapWith((p: Record<string, unknown>) => {
      const ptyHandle = (p?.ptyHandle ?? p?.pty_handle) as string;
      const cols = p?.cols as number;
      const rows = p?.rows as number;
      if (!ptyHandle) throw new Error('one_shot_terminal_resize: ptyHandle is required');
      oneShotTerminal?.resize(ptyHandle, cols, rows);
      return null;
    }),
    one_shot_terminal_kill: wrapWith((p: Record<string, unknown>) => {
      const ptyHandle = (p?.ptyHandle ?? p?.pty_handle) as string;
      if (!ptyHandle) throw new Error('one_shot_terminal_kill: ptyHandle is required');
      oneShotTerminal?.kill(ptyHandle);
      return null;
    }),

    codex_auth_status: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      if (!codexAuth || !configDir) return { authenticated: false };
      return codexAuth.getStatus(configDir);
    }),
    codex_auth_start_login: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      const codexBinaryPath = (p?.codexBinaryPath ?? p?.codex_binary_path) as string | undefined;
      if (!codexAuth) throw new Error('codex_auth_start_login: codex auth service not available');
      if (!configDir) throw new Error('codex_auth_start_login: configDir is required');
      return codexAuth.startLoginFlow(codexBinaryPath ? { configDir, codexBinaryPath } : { configDir });
    }),
    codex_auth_cancel_login: wrapWith((p: Record<string, unknown>) => {
      const ptyHandle = (p?.ptyHandle ?? p?.pty_handle) as string;
      if (!ptyHandle) throw new Error('codex_auth_cancel_login: ptyHandle is required');
      codexAuth?.cancelLoginFlow(ptyHandle);
      return null;
    }),
    codex_binary_path: wrap(() => codexAuth?.getBinaryPath() ?? null),
    codex_logout: wrapWith(async (p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      if (!codexAuth || !configDir) return null;
      await codexAuth.logout(configDir);
      return null;
    }),

    claude_auth_begin: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      if (!configDir) throw new Error('claude_auth_begin: configDir is required');
      if (!claudeAuth) throw new Error('claude_auth_begin: claude auth service not available');
      return claudeAuth.beginSignIn(configDir);
    }),
    claude_auth_submit_code: wrapWith((p: Record<string, unknown>) => {
      const flowId = (p?.flowId ?? p?.flow_id) as string | undefined;
      const code = p?.code as string | undefined;
      if (!flowId) throw new Error('claude_auth_submit_code: flowId is required');
      if (!code) throw new Error('claude_auth_submit_code: code is required');
      if (!claudeAuth) throw new Error('claude_auth_submit_code: claude auth service not available');
      return claudeAuth.submitCode(flowId, code);
    }),
    claude_auth_wait: wrapWith((p: Record<string, unknown>) => {
      const flowId = (p?.flowId ?? p?.flow_id) as string | undefined;
      if (!flowId) throw new Error('claude_auth_wait: flowId is required');
      if (!claudeAuth) throw new Error('claude_auth_wait: claude auth service not available');
      return claudeAuth.waitForCompletion(flowId);
    }),
    claude_auth_cancel: wrapWith(async (p: Record<string, unknown>) => {
      const flowId = (p?.flowId ?? p?.flow_id) as string | undefined;
      if (!flowId || !claudeAuth) return null;
      await claudeAuth.cancel(flowId);
      return null;
    }),
    claude_auth_logout: wrapWith(async (p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      if (!configDir) throw new Error('claude_auth_logout: configDir is required');
      if (!claudeAuth) throw new Error('claude_auth_logout: claude auth service not available');
      await claudeAuth.logout(configDir);
      return null;
    }),

    codex_session_list: wrap(() => codexSessionWalker?.listSessions() ?? []),
  };

  return map;
}
