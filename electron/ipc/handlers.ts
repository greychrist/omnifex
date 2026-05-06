/**
 * IPC Handler Registration
 *
 * Maintains the map of channel names to handler functions and registers them
 * with ipcMain. Services are injected so handlers can be registered
 * incrementally as services are implemented in later tasks.
 *
 * The handler map is also exported for testing without requiring ipcMain.
 */

import type { Database } from '../services/database';
import type { PermissionsIOService } from '../services/permissions-io';
import { validateCliPath } from '../services/cli-path-validator';

// Services parameter type — each property is optional so we can add services
// one task at a time without breaking the registration call.
export interface Services {
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
    explainResolution(projectPath: string): unknown;
  };
  claude?: {
    listProjects(configDir?: string): unknown;
    createProject(data: unknown): unknown;
    getProjectSessions(projectId: string, projectPath?: string): unknown;
    loadSessionHistory(sessionId: string, projectId: string): unknown;
    deleteSession(sessionId: string, projectId: string, projectPath?: string): unknown;
    getHomeDirectory(): unknown;
    getSettings(opts?: unknown): unknown;
    saveSettings(settings: unknown, opts?: unknown): unknown;
    getSystemPrompt(opts?: unknown): unknown;
    saveSystemPrompt(prompt: unknown, opts?: unknown): unknown;
    checkVersion(): unknown;
    findClaudeMdFiles(projectPath: string): unknown;
    readClaudeMdFile(filePath: string): unknown;
    saveClaudeMdFile(filePath: string, content: string): unknown;
    getHooksConfig(scope: string, opts?: unknown): unknown;
    updateHooksConfig(scope: string, config: unknown, opts?: unknown): unknown;
    validateHookCommand(command: string): unknown;
    getMergedHooksConfig(projectPath: string, opts?: unknown): unknown;
    getCliUsage(configDir?: string): unknown;
  };
  sessions?: {
    start(data: unknown): unknown;
    rebind(tabId: string, ownerWebContentsId: number): boolean;
    sendMessage(sessionId: string, message: unknown): unknown;
    sendStructuredMessage(sessionId: string, content: unknown): unknown;
    respondPermission(sessionId: string, behavior: string, updatedInput?: Record<string, unknown>, updatedPermissions?: unknown[]): unknown;
    respondElicitation(tabId: string, action: string, content?: Record<string, unknown>): unknown;
    stop(sessionId: string): unknown;
    getInfo(sessionId: string): unknown;
    getHealth(sessionId: string): { alive: boolean; status: string; sessionId: string | null };
    // Wave 2 — Query-method passthroughs
    interrupt(sessionId: string): unknown;
    setModel(sessionId: string, model?: string): unknown;
    setPermissionMode(sessionId: string, mode: string): unknown;
    setEffort(sessionId: string, level: unknown): unknown;
    applyPermissions(sessionId: string, permissions: unknown): unknown;
    setThinking(sessionId: string, config: unknown): unknown;
    getAccountInfo(sessionId: string): unknown;
    getContextUsage(sessionId: string): unknown;
    getSupportedCommands(sessionId: string): unknown;
    getSupportedModels(sessionId: string): unknown;
    getMcpServerStatus(sessionId: string): unknown;
    getPlugins(sessionId: string, force?: boolean): unknown;
    setMode(tabId: string, mode: 'sdk' | 'tui'): Promise<unknown>;
    tuiWrite(tabId: string, data: string): unknown;
    tuiResize(tabId: string, cols: number, rows: number): unknown;
    getMode(tabId: string): unknown;
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
  };
  sdkVersion?: {
    getReferenced(): Promise<string | null>;
    getLatest(): Promise<string | null>;
  };
  gitWatcher?: {
    listWorktrees(projectPath: string): Promise<Array<{ path: string; branch: string | null }>>;
    startSession(projectPath: string): Promise<{
      watchId: string;
      snapshot: import('../services/git-watcher').SessionGitSnapshot;
    }>;
    reconnectSession(watchId: string): Promise<import('../services/git-watcher').SessionGitSnapshot | null>;
    stopSession(watchId: string): void;
  };
  branchColors?: {
    listForProject(projectPath: string): unknown;
    upsert(input: { project_path: string; branch_name: string; color: string }): unknown;
    delete(id: number): unknown;
  };
  gitBranches?: {
    list(projectPath: string): Promise<string[]>;
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
}

// The handler type used in the map — receives the IPC event plus the params
// object that the renderer sends via invoke(channel, params).
type HandlerFn = (event: unknown, params?: Record<string, unknown>) => Promise<unknown>;

function wrap(fn: () => unknown): HandlerFn {
  return async (_event: unknown, _params?: Record<string, unknown>) => {
    try {
      return await fn();
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  };
}

function wrapWith<P>(fn: (params: P) => unknown): HandlerFn {
  return async (_event: unknown, params?: Record<string, unknown>) => {
    try {
      return await fn(params as unknown as P);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  };
}

/**
 * Build and return the full channel → handler map.
 * When a service is not provided, the handler resolves with `null` so the
 * renderer gets a defined (but empty) response rather than a blocked channel.
 */
export function getHandlerMap(services: Services = {}): Record<string, HandlerFn> {
  const { accounts, claude, sessions, usage, rateLimits, usageRunner, claudeBinary, mcp, slashCommands, sessionsSummary, logging, database, proxy, permissionsIO, models, sdkVersion, gitWatcher, branchColors, gitBranches, lima } = services;

  const map: Record<string, HandlerFn> = {
    // ── Accounts ──────────────────────────────────────────────────────────────
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
    explain_account_resolution: wrapWith((p: Record<string, unknown>) => accounts?.explainResolution((p?.projectPath ?? p?.project_path) as string) ?? null),

    // ── Claude ────────────────────────────────────────────────────────────────
    list_projects: wrapWith((p: Record<string, unknown>) => claude?.listProjects(p?.config_dir as string | undefined) ?? null),
    create_project: wrapWith((p: Record<string, unknown>) => claude?.createProject(p) ?? null),
    get_project_sessions: wrapWith((p: Record<string, unknown>) => claude?.getProjectSessions((p?.projectId ?? p?.project_id) as string, (p?.projectPath ?? p?.project_path) as string | undefined) ?? null),
    load_session_history: wrapWith((p: Record<string, unknown>) => claude?.loadSessionHistory((p?.sessionId ?? p?.session_id) as string, (p?.projectId ?? p?.project_id) as string) ?? null),
    delete_session: wrapWith((p: Record<string, unknown>) => claude?.deleteSession((p?.sessionId ?? p?.session_id) as string, (p?.projectId ?? p?.project_id) as string, (p?.projectPath ?? p?.project_path) as string | undefined) ?? null),
    get_home_directory: wrap(() => claude?.getHomeDirectory() ?? null),
    get_claude_settings: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      return claude?.getSettings(configDir ? { configDir } : undefined) ?? null;
    }),
    save_claude_settings: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      const settings = p?.settings ?? p;
      return claude?.saveSettings(settings, configDir ? { configDir } : undefined) ?? null;
    }),
    get_system_prompt: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      return claude?.getSystemPrompt(configDir ? { configDir } : undefined) ?? null;
    }),
    save_system_prompt: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      return claude?.saveSystemPrompt(p?.content ?? p?.prompt, configDir ? { configDir } : undefined) ?? null;
    }),
    check_claude_version: wrap(() => claude?.checkVersion() ?? null),
    find_claude_md_files: wrapWith((p: Record<string, unknown>) => claude?.findClaudeMdFiles((p?.projectPath ?? p?.project_path) as string) ?? null),
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

    // ── Sessions ──────────────────────────────────────────────────────────────
    session_start: wrapWith((p: Record<string, unknown>) => sessions?.start(p) ?? null),
    session_rebind: wrapWith((p: Record<string, unknown>) => {
      const tabId = (p?.tabId ?? p?.session_id) as string;
      const ownerWebContentsId = p?.ownerWebContentsId as number | undefined;
      if (!tabId || ownerWebContentsId === undefined) return false;
      return sessions?.rebind(tabId, ownerWebContentsId) ?? false;
    }),
    session_send_message: wrapWith((p: Record<string, unknown>) => sessions?.sendMessage((p?.tabId ?? p?.session_id) as string, (p?.prompt ?? p?.message) as string) ?? null),
    session_send_structured_message: wrapWith((p: Record<string, unknown>) => sessions?.sendStructuredMessage((p?.tabId ?? p?.session_id) as string, p?.content as Array<Record<string, unknown>>) ?? null),
    session_respond_permission: wrapWith((p: Record<string, unknown>) => sessions?.respondPermission((p?.tabId ?? p?.session_id) as string, p?.behavior as string, p?.updatedInput as Record<string, unknown> | undefined, p?.updatedPermissions as any) ?? null),
    session_respond_elicitation: wrapWith((p: Record<string, unknown>) => sessions?.respondElicitation((p?.tabId ?? p?.tab_id) as string, (p?.action) as string, p?.content as Record<string, unknown> | undefined) ?? null),
    session_stop: wrapWith((p: Record<string, unknown>) => sessions?.stop((p?.tabId ?? p?.session_id) as string) ?? null),
    session_get_info: wrapWith((p: Record<string, unknown>) => sessions?.getInfo((p?.tabId ?? p?.session_id) as string) ?? null),
    session_get_health: wrapWith((p: Record<string, unknown>) => sessions?.getHealth((p?.tabId ?? p?.session_id) as string) ?? { alive: false, status: 'stopped', sessionId: null }),
    // Wave 2 — Query-method passthroughs
    session_interrupt: wrapWith((p: Record<string, unknown>) => sessions?.interrupt((p?.tabId ?? p?.session_id) as string) ?? null),
    session_set_model: wrapWith((p: Record<string, unknown>) => sessions?.setModel((p?.tabId ?? p?.session_id) as string, p?.model as string | undefined) ?? null),
    session_set_permission_mode: wrapWith((p: Record<string, unknown>) => sessions?.setPermissionMode((p?.tabId ?? p?.session_id) as string, (p?.mode ?? p?.permissionMode) as string) ?? null),
    session_set_effort: wrapWith((p: Record<string, unknown>) => sessions?.setEffort((p?.tabId ?? p?.session_id) as string, (p?.level ?? p?.effort) as any) ?? null),
    session_set_thinking: wrapWith((p: Record<string, unknown>) => sessions?.setThinking((p?.tabId ?? p?.session_id) as string, (p?.config ?? p?.thinking) as any) ?? null),
    session_account_info: wrapWith((p: Record<string, unknown>) => sessions?.getAccountInfo((p?.tabId ?? p?.session_id) as string) ?? null),
    session_context_usage: wrapWith((p: Record<string, unknown>) => sessions?.getContextUsage((p?.tabId ?? p?.session_id) as string) ?? null),
    session_supported_commands: wrapWith((p: Record<string, unknown>) => sessions?.getSupportedCommands((p?.tabId ?? p?.session_id) as string) ?? null),
    session_supported_models: wrapWith((p: Record<string, unknown>) => sessions?.getSupportedModels((p?.tabId ?? p?.session_id) as string) ?? null),
    session_mcp_server_status: wrapWith((p: Record<string, unknown>) => sessions?.getMcpServerStatus((p?.tabId ?? p?.session_id) as string) ?? null),
    session_plugins: wrapWith((p: Record<string, unknown>) => sessions?.getPlugins((p?.tabId ?? p?.session_id) as string, Boolean(p?.force)) ?? null),
    session_set_mode: wrapWith((p: Record<string, unknown>) =>
      sessions?.setMode(
        (p?.tabId ?? p?.session_id) as string,
        (p?.mode ?? p?.session_mode) as 'sdk' | 'tui',
      ) ?? null
    ),
    session_tui_write: wrapWith((p: Record<string, unknown>) =>
      sessions?.tuiWrite(
        (p?.tabId ?? p?.session_id) as string,
        (p?.data ?? p?.tui_data) as string,
      ) ?? null
    ),
    session_tui_resize: wrapWith((p: Record<string, unknown>) =>
      sessions?.tuiResize(
        (p?.tabId ?? p?.session_id) as string,
        (p?.cols ?? p?.num_cols) as number,
        (p?.rows ?? p?.num_rows) as number,
      ) ?? null
    ),

    // ── Standalone model list (no active session required) ─────────────────
    list_supported_models: wrapWith((p: Record<string, unknown>) => models?.listSupported((p?.configDir ?? p?.config_dir) as string) ?? []),

    // ── Session Permissions ────────────────────────────────────────────────
    session_get_permissions: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir ?? '') as string;
      const projectPath = (p?.projectPath ?? p?.project_path) as string | undefined;
      return permissionsIO?.getPermissions(configDir, projectPath) ?? null;
    }),

    session_update_permission: wrapWith((p: Record<string, unknown>) => {
      const configDir = (p?.configDir ?? p?.config_dir) as string | undefined;
      const projectPath = (p?.projectPath ?? p?.project_path) as string | undefined;
      const tabId = (p?.tabId ?? p?.session_id) as string | undefined;

      permissionsIO?.updatePermission({
        configDir,
        projectPath,
        scope: p?.scope as 'user' | 'project' | 'local',
        action: p?.action as 'add' | 'remove',
        behavior: p?.behavior as 'allow' | 'deny',
        rule: p?.rule as string,
      });

      // Mirror the on-disk change into the live SDK session so the user
      // doesn't get re-prompted for a rule they just allowed. The SDK
      // loads settings files only at session start and never re-reads
      // them, so this push is the only way to keep an active query in
      // sync with rule edits made via the UI.
      if (tabId && configDir && sessions && permissionsIO) {
        try {
          const levels = permissionsIO.getPermissions(configDir, projectPath);
          const allow = Array.from(new Set(levels.flatMap((l) => l.allow)));
          const deny = Array.from(new Set(levels.flatMap((l) => l.deny)));
          // Fire-and-forget — the service swallows its own errors.
          void sessions.applyPermissions(tabId, { allow, deny });
        } catch (err) {
          console.error('[handlers] applyPermissions push failed:', err);
        }
      }

      return null;
    }),


    // ── Usage ─────────────────────────────────────────────────────────────────
    get_usage_stats: wrapWith((p: Record<string, unknown>) => usage?.getStats(p) ?? null),
    get_usage_by_date_range: wrapWith((p: Record<string, unknown>) => usage?.getByDateRange(p) ?? null),
    get_session_stats: wrapWith((p: Record<string, unknown>) => usage?.getSessionStats(p) ?? null),
    get_usage_details: wrapWith((p: Record<string, unknown>) => usage?.getDetails(p) ?? null),
    get_usage_by_account: wrapWith((p: Record<string, unknown>) => usage?.getStatsByAccount(p) ?? null),

    // ── Rate Limits ───────────────────────────────────────────────────────────
    get_rate_limits: wrapWith((p: Record<string, unknown>) => {
      const accountName = (p?.accountName ?? p?.account_name) as string | undefined;
      if (accountName) return rateLimits?.getSnapshotsByAccount(accountName) ?? [];
      return rateLimits?.getSnapshots() ?? [];
    }),
    get_rate_limit_settings: wrap(() => rateLimits?.getSettings() ?? null),
    update_rate_limit_settings: wrapWith((p: Record<string, unknown>) => rateLimits?.updateSettings(p) ?? null),

    // ── Usage CLI Runner ──────────────────────────────────────────────────────
    usage_run_cli: wrapWith((p: Record<string, unknown>) =>
      usageRunner?.run((p?.accountName ?? p?.account_name) as string) ?? null,
    ),
    usage_get_last: wrapWith((p: Record<string, unknown>) =>
      usageRunner?.getLast((p?.accountName ?? p?.account_name) as string) ?? null,
    ),
    accounts_validate_cli_path: wrapWith((p: Record<string, unknown>) =>
      validateCliPath(((p?.path ?? p?.cli_path) as string | null | undefined) ?? null),
    ),

    // ── Claude Binary ─────────────────────────────────────────────────────────
    get_claude_binary_path: wrap(() => claudeBinary?.getPath() ?? null),
    set_claude_binary_path: wrapWith((p: Record<string, unknown>) => claudeBinary?.setPath(p?.path as string) ?? null),
    list_claude_installations: wrap(() => claudeBinary?.listInstallations() ?? null),

    // ── MCP ───────────────────────────────────────────────────────────────────
    mcp_add: wrapWith((p: Record<string, unknown>) => mcp?.add(p) ?? null),
    mcp_list: wrapWith((p: Record<string, unknown>) => mcp?.list((p?.configDir ?? p?.config_dir) as string | undefined) ?? null),
    mcp_get: wrapWith((p: Record<string, unknown>) => mcp?.get(p?.name as string, (p?.configDir ?? p?.config_dir) as string | undefined) ?? null),
    mcp_remove: wrapWith((p: Record<string, unknown>) => mcp?.remove(p?.name as string, (p?.configDir ?? p?.config_dir) as string | undefined) ?? null),
    mcp_add_json: wrapWith((p: Record<string, unknown>) => mcp?.addJson(p) ?? null),
    mcp_add_from_claude_desktop: wrapWith((p: Record<string, unknown>) => mcp?.addFromClaudeDesktop(p?.scope as string | undefined, (p?.configDir ?? p?.config_dir) as string | undefined) ?? null),
    mcp_serve: wrapWith((p: Record<string, unknown>) => mcp?.serve() ?? null),
    mcp_test_connection: wrapWith((p: Record<string, unknown>) => mcp?.testConnection(p?.name as string, (p?.configDir ?? p?.config_dir) as string | undefined) ?? null),
    mcp_reset_project_choices: wrap(() => mcp?.resetProjectChoices() ?? null),
    mcp_get_server_status: wrapWith((p: Record<string, unknown>) => mcp?.getServerStatus((p?.configDir ?? p?.config_dir) as string | undefined) ?? null),
    mcp_read_project_config: wrapWith((p: Record<string, unknown>) => mcp?.readProjectConfig((p?.projectPath ?? p?.project_path) as string) ?? null),
    mcp_save_project_config: wrapWith((p: Record<string, unknown>) => mcp?.saveProjectConfig((p?.projectPath ?? p?.project_path) as string, p?.config) ?? null),

    // ── Slash Commands ────────────────────────────────────────────────────────
    slash_commands_list: wrapWith((p: Record<string, unknown>) => slashCommands?.list(
      (p?.projectPath ?? p?.project_path) as string | undefined,
      (p?.configDir ?? p?.config_dir) as string | undefined,
    ) ?? null),
    slash_command_get: wrapWith((p: Record<string, unknown>) => slashCommands?.get(
      (p?.commandId ?? p?.command_id) as string,
      (p?.configDir ?? p?.config_dir) as string | undefined,
    ) ?? null),
    slash_command_save: wrapWith((p: Record<string, unknown>) => slashCommands?.save(p as any) ?? null),
    slash_command_delete: wrapWith((p: Record<string, unknown>) => slashCommands?.delete(
      (p?.commandId ?? p?.command_id) as string,
      (p?.projectPath ?? p?.project_path) as string | undefined,
      (p?.configDir ?? p?.config_dir) as string | undefined,
    ) ?? null),

    // ── Session Summaries ─────────────────────────────────────────────────────
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
    // Snapshot of session uuids whose model call is currently in flight.
    // SessionList queries this on mount to seed the spinner state for
    // background auto-on-close runs that started before it subscribed.
    summary_generating_now: wrap(() => sessionsSummary?.getGeneratingSessionUuids() ?? []),

    // ── Logging ───────────────────────────────────────────────────────────────
    log_write_batch: wrapWith((p: Record<string, unknown>) => logging?.writeBatch(p?.entries) ?? null),
    log_query: wrapWith((p: Record<string, unknown>) => logging?.query(p) ?? null),
    log_count: wrapWith((p: Record<string, unknown>) => logging?.count(p) ?? null),
    log_prune: wrapWith((p: Record<string, unknown>) => logging?.prune(p?.olderThan as string | undefined) ?? null),

    // ── Storage (database) ────────────────────────────────────────────────────
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
        // Get columns — return full PRAGMA info so the renderer gets pk, type_name, etc.
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

        // Build query
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
      const wheres = Object.keys(primaryKeyValues).map(k => `"${k}" = ?`).join(' AND ');
      return database.raw.prepare(`DELETE FROM "${table}" WHERE ${wheres}`).run(...Object.values(primaryKeyValues));
    }),
    storage_insert_row: wrapWith((p: Record<string, unknown>) => {
      if (!database) return null;
      const table = (p?.tableName ?? p?.table_name) as string;
      const values = (p?.values ?? p?.data) as Record<string, unknown>;
      if (!table || !values) return null;
      const cols = Object.keys(values).map(k => `"${k}"`).join(', ');
      const placeholders = Object.keys(values).map(() => '?').join(', ');
      return database.raw.prepare(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`).run(...Object.values(values));
    }),
    storage_execute_sql: wrapWith((p: Record<string, unknown>) => {
      if (!database) return null;
      const sql = (p?.query ?? p?.sql) as string;
      if (!sql) return null;
      return database.raw.prepare(sql).all();
    }),
    storage_reset_database: wrap(() => null), // intentionally noop until implemented
    get_setting: wrapWith((p: Record<string, unknown>) => database?.getSetting(p?.key as string) ?? null),
    save_setting: wrapWith((p: Record<string, unknown>) => {
      database?.saveSetting(p?.key as string, p?.value as string);
      return null;
    }),

    // ── Git ──────────────────────────────────────────────────────────────────
    get_git_branch: wrapWith(async (p: Record<string, unknown>) => {
      const projectPath = (p?.projectPath ?? p?.project_path) as string;
      if (!projectPath) return null;
      try {
        const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
        return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath, encoding: 'utf8' }).trim();
      } catch { return null; }
    }),

    // ── Proxy ─────────────────────────────────────────────────────────────────
    get_proxy_settings: wrap(() => proxy?.getSettings() ?? null),
    save_proxy_settings: wrapWith((p: Record<string, unknown>) => proxy?.saveSettings(p) ?? null),

    // ── SDK version ──────────────────────────────────────────────────────────
    get_referenced_sdk_version: wrap(() => sdkVersion?.getReferenced() ?? null),
    get_latest_sdk_version: wrap(() => sdkVersion?.getLatest() ?? null),

    // ── Git watcher ──────────────────────────────────────────────────────────
    list_git_worktrees: wrapWith(async (p: Record<string, unknown>) => {
      const projectPath = (p?.projectPath ?? p?.project_path) as string;
      if (!projectPath || !gitWatcher) return [];
      return gitWatcher.listWorktrees(projectPath);
    }),
    start_session_git_watch: wrapWith(async (p: Record<string, unknown>) => {
      const projectPath = (p?.projectPath ?? p?.project_path) as string;
      if (!projectPath || !gitWatcher) return null;
      return gitWatcher.startSession(projectPath);
    }),
    stop_session_git_watch: wrapWith(async (p: Record<string, unknown>) => {
      const watchId = (p?.watchId ?? p?.watch_id) as string;
      if (!watchId || !gitWatcher) return null;
      gitWatcher.stopSession(watchId);
      return null;
    }),
    reconnect_session_git_watch: wrapWith(async (p: Record<string, unknown>) => {
      const watchId = (p?.watchId ?? p?.watch_id) as string;
      if (!watchId || !gitWatcher) return null;
      return gitWatcher.reconnectSession(watchId);
    }),

    // ── Branch Colors ─────────────────────────────────────────────────────────
    branch_colors_list: wrapWith((p: Record<string, unknown>) =>
      branchColors?.listForProject((p?.projectPath ?? p?.project_path) as string) ?? [],
    ),
    branch_colors_upsert: wrapWith((p: Record<string, unknown>) =>
      branchColors?.upsert({
        project_path: (p?.projectPath ?? p?.project_path) as string,
        branch_name: (p?.branchName ?? p?.branch_name) as string,
        color: p?.color as string,
      }) ?? null,
    ),
    branch_colors_delete: wrapWith((p: Record<string, unknown>) =>
      branchColors?.delete(p?.id as number) ?? false,
    ),

    // ── Git Branches ──────────────────────────────────────────────────────────
    git_list_branches: wrapWith((p: Record<string, unknown>) =>
      gitBranches?.list((p?.projectPath ?? p?.project_path) as string) ?? [],
    ),

    // ── Lima (VM viewer) ──────────────────────────────────────────────────────
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
  };

  return map;
}

/**
 * Register all handlers with ipcMain and add the Electron-specific handlers
 * for dialog, shell, and window controls.
 *
 * This function must only be called from the main process.
 *
 * Coverage note: this function is excluded from unit-test coverage because
 * it requires the real `electron` module, which is not available under Node.
 * The dispatch logic it wires up is fully covered via `getHandlerMap()` tests.
 */
/* v8 ignore start */
export function registerIpcHandlers(services: Services = {}): void {
  // Lazy-require Electron main-process modules so this file can be imported
  // in test environments where `electron` is not available.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ipcMain, dialog, shell, BrowserWindow } = require('electron') as typeof import('electron');

  const handlerMap = getHandlerMap(services);

  // Channels that should have the caller's webContents.id injected into their
  // params so the corresponding service can register per-window event routing.
  // (Session and agent event channels are window-scoped so streams don't leak
  // into other windows when the user has multiple open.)
  const OWNER_INJECTED_CHANNELS = new Set(['session_start', 'session_rebind', 'execute_agent']);

  for (const [channel, handler] of Object.entries(handlerMap)) {
    if (OWNER_INJECTED_CHANNELS.has(channel)) {
      ipcMain.handle(channel, async (event, params) => {
        const augmented = {
          ...(params ?? {}),
          ownerWebContentsId: event.sender.id,
        };
        return handler(event, augmented);
      });
    } else {
      ipcMain.handle(channel, handler);
    }
  }

  // ── Dialog handlers ────────────────────────────────────────────────────────
  ipcMain.handle('dialog:open', async (_event, options: Electron.OpenDialogOptions) => {
    const result = await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths;
  });

  ipcMain.handle('dialog:save', async (_event, options: Electron.SaveDialogOptions) => {
    const result = await dialog.showSaveDialog(options);
    return result.canceled ? null : result.filePath;
  });

  // ── Shell handler ──────────────────────────────────────────────────────────
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    return shell.openExternal(url);
  });

  ipcMain.handle('reveal_path_in_finder', async (_event, data: any) => {
    const p: string = data?.path ?? data;
    if (!p || typeof p !== 'string') throw new Error('reveal_path_in_finder: path is required');
    shell.showItemInFolder(p);
    return null;
  });

  // ── Window control handlers ────────────────────────────────────────────────
  ipcMain.handle('window:minimize', () => {
    BrowserWindow.getFocusedWindow()?.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      win.isMaximized() ? win.unmaximize() : win.maximize();
    }
  });

  ipcMain.handle('window:close', () => {
    BrowserWindow.getFocusedWindow()?.close();
  });

  // ── File handlers ─────────────────────────────────────────────────────────
  ipcMain.handle('save_pasted_image', async (_event, params: { dataUrl: string }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os');

    const { dataUrl } = params;
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) throw new Error('Invalid image data URL');
    const ext = match[1];
    const base64 = match[2];

    const tmpDir = path.join(os.tmpdir(), 'greychrist-pastes');
    fs.mkdirSync(tmpDir, { recursive: true });
    const fileName = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = path.join(tmpDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return filePath;
  });
}
/* v8 ignore stop */
