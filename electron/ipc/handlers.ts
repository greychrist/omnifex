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

// Services parameter type — each property is optional so we can add services
// one task at a time without breaking the registration call.
export interface Services {
  accounts?: {
    list(): unknown;
    create(data: unknown): unknown;
    update(id: unknown, data: unknown): unknown;
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
    loadAgentSessionHistory(sessionId: string): unknown;
    getHomeDirectory(): unknown;
    getSettings(): unknown;
    saveSettings(settings: unknown): unknown;
    getSystemPrompt(): unknown;
    saveSystemPrompt(prompt: unknown): unknown;
    checkVersion(): unknown;
    findClaudeMdFiles(projectPath: string): unknown;
    readClaudeMdFile(filePath: string): unknown;
    saveClaudeMdFile(filePath: string, content: string): unknown;
    getHooksConfig(): unknown;
    updateHooksConfig(config: unknown): unknown;
    validateHookCommand(command: string): unknown;
    getMergedHooksConfig(): unknown;
  };
  sessions?: {
    start(data: unknown): unknown;
    sendMessage(sessionId: string, message: unknown): unknown;
    sendStructuredMessage(sessionId: string, content: unknown): unknown;
    respondPermission(sessionId: string, behavior: string, updatedInput?: Record<string, unknown>): unknown;
    stop(sessionId: string): unknown;
    getInfo(sessionId: string): unknown;
  };
  agents?: {
    list(): unknown;
    create(data: unknown): unknown;
    update(id: unknown, data: unknown): unknown;
    delete(id: unknown): unknown;
    get(id: unknown): unknown;
    export(id: unknown): unknown;
    import(data: unknown): unknown;
    execute(agentId: unknown, data: unknown): unknown;
    listRuns(): unknown;
    getRun(id: unknown): unknown;
    getRunWithMetrics(id: unknown): unknown;
    killSession(runId: unknown): unknown;
    getSessionStatus(runId: unknown): unknown;
    cleanupFinished(): unknown;
    getSessionOutput(runId: unknown): unknown;
    getLiveSessionOutput(runId: unknown): unknown;
    streamSessionOutput(runId: unknown): unknown;
    fetchGithubAgents(): unknown;
    fetchGithubAgentContent(data: unknown): unknown;
    importFromGithub(data: unknown): unknown;
  };
  usage?: {
    getStats(params?: unknown): unknown;
    getByDateRange(params: unknown): unknown;
    getSessionStats(params?: unknown): unknown;
    getDetails(params?: unknown): unknown;
  };
  checkpoints?: {
    create(data: unknown): unknown;
    restore(data: unknown): unknown;
    list(data: unknown): unknown;
    forkFrom(data: unknown): unknown;
    getTimeline(data: unknown): unknown;
    updateSettings(data: unknown): unknown;
    getDiff(data: unknown): unknown;
  };
  claudeBinary?: {
    getPath(): unknown;
    setPath(path: string): unknown;
    listInstallations(): unknown;
  };
  mcp?: {
    add(data: unknown): unknown;
    list(): unknown;
    get(name: string): unknown;
    remove(name: string): unknown;
    addJson(data: unknown): unknown;
    addFromClaudeDesktop(): unknown;
    serve(data: unknown): unknown;
    testConnection(name: string): unknown;
    resetProjectChoices(): unknown;
    getServerStatus(): unknown;
    readProjectConfig(data: unknown): unknown;
    saveProjectConfig(data: unknown): unknown;
  };
  slashCommands?: {
    list(): unknown;
    get(commandId: string): unknown;
    save(data: unknown): unknown;
    delete(commandId: string, projectPath?: string): unknown;
  };
  logging?: {
    writeBatch(entries: unknown): unknown;
    query(params: unknown): unknown;
  };
  database?: Database;
  proxy?: {
    getSettings(): unknown;
    saveSettings(data: unknown): unknown;
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
  const { accounts, claude, sessions, agents, usage, checkpoints, claudeBinary, mcp, slashCommands, logging, database, proxy } = services;

  const map: Record<string, HandlerFn> = {
    // ── Accounts ──────────────────────────────────────────────────────────────
    list_accounts: wrap(() => accounts?.list() ?? null),
    create_account: wrapWith((p: Record<string, unknown>) => accounts?.create(p) ?? null),
    update_account: wrapWith((p: Record<string, unknown>) => accounts?.update(p?.id, p) ?? null),
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
    load_agent_session_history: wrapWith((p: Record<string, unknown>) => claude?.loadAgentSessionHistory((p?.sessionId ?? p?.session_id) as string) ?? null),
    get_home_directory: wrap(() => claude?.getHomeDirectory() ?? null),
    get_claude_settings: wrap(() => claude?.getSettings() ?? null),
    save_claude_settings: wrapWith((p: Record<string, unknown>) => claude?.saveSettings(p) ?? null),
    get_system_prompt: wrap(() => claude?.getSystemPrompt() ?? null),
    save_system_prompt: wrapWith((p: Record<string, unknown>) => claude?.saveSystemPrompt(p?.content ?? p?.prompt) ?? null),
    check_claude_version: wrap(() => claude?.checkVersion() ?? null),
    find_claude_md_files: wrapWith((p: Record<string, unknown>) => claude?.findClaudeMdFiles((p?.projectPath ?? p?.project_path) as string) ?? null),
    read_claude_md_file: wrapWith((p: Record<string, unknown>) => claude?.readClaudeMdFile((p?.filePath ?? p?.file_path) as string) ?? null),
    save_claude_md_file: wrapWith((p: Record<string, unknown>) => claude?.saveClaudeMdFile((p?.filePath ?? p?.file_path) as string, p?.content as string) ?? null),
    get_hooks_config: wrap(() => claude?.getHooksConfig() ?? null),
    update_hooks_config: wrapWith((p: Record<string, unknown>) => claude?.updateHooksConfig(p) ?? null),
    validate_hook_command: wrapWith((p: Record<string, unknown>) => claude?.validateHookCommand(p?.command as string) ?? null),
    get_merged_hooks_config: wrap(() => claude?.getMergedHooksConfig() ?? null),

    // ── Sessions ──────────────────────────────────────────────────────────────
    session_start: wrapWith((p: Record<string, unknown>) => sessions?.start(p) ?? null),
    session_send_message: wrapWith((p: Record<string, unknown>) => sessions?.sendMessage((p?.tabId ?? p?.session_id) as string, (p?.prompt ?? p?.message) as string) ?? null),
    session_send_structured_message: wrapWith((p: Record<string, unknown>) => sessions?.sendStructuredMessage((p?.tabId ?? p?.session_id) as string, p?.content as Array<Record<string, unknown>>) ?? null),
    session_respond_permission: wrapWith((p: Record<string, unknown>) => sessions?.respondPermission((p?.tabId ?? p?.session_id) as string, p?.behavior as string, p?.updatedInput as Record<string, unknown> | undefined) ?? null),
    session_stop: wrapWith((p: Record<string, unknown>) => sessions?.stop((p?.tabId ?? p?.session_id) as string) ?? null),
    session_get_info: wrapWith((p: Record<string, unknown>) => sessions?.getInfo((p?.tabId ?? p?.session_id) as string) ?? null),

    // ── Agents ────────────────────────────────────────────────────────────────
    list_agents: wrap(() => agents?.list() ?? null),
    create_agent: wrapWith((p: Record<string, unknown>) => agents?.create(p) ?? null),
    update_agent: wrapWith((p: Record<string, unknown>) => agents?.update(p?.id, p) ?? null),
    delete_agent: wrapWith((p: Record<string, unknown>) => agents?.delete(p?.id) ?? null),
    get_agent: wrapWith((p: Record<string, unknown>) => agents?.get(p?.id) ?? null),
    export_agent: wrapWith((p: Record<string, unknown>) => agents?.export(p?.id) ?? null),
    import_agent: wrapWith((p: Record<string, unknown>) => agents?.import(p) ?? null),
    execute_agent: wrapWith((p: Record<string, unknown>) => agents?.execute(p?.agentId ?? p?.agent_id, p) ?? null),
    list_agent_runs: wrap(() => agents?.listRuns() ?? null),
    list_running_sessions: wrap(() => agents?.listRuns() ?? []),
    get_agent_run: wrapWith((p: Record<string, unknown>) => agents?.getRun(p?.id) ?? null),
    get_agent_run_with_real_time_metrics: wrapWith((p: Record<string, unknown>) => agents?.getRunWithMetrics(p?.id) ?? null),
    kill_agent_session: wrapWith((p: Record<string, unknown>) => agents?.killSession(p?.runId ?? p?.run_id) ?? null),
    get_session_status: wrapWith((p: Record<string, unknown>) => agents?.getSessionStatus(p?.runId ?? p?.run_id) ?? null),
    cleanup_finished_processes: wrap(() => agents?.cleanupFinished() ?? null),
    get_session_output: wrapWith((p: Record<string, unknown>) => agents?.getSessionOutput(p?.runId ?? p?.run_id) ?? null),
    get_live_session_output: wrapWith((p: Record<string, unknown>) => agents?.getLiveSessionOutput(p?.runId ?? p?.run_id) ?? null),
    stream_session_output: wrapWith((p: Record<string, unknown>) => agents?.streamSessionOutput(p?.runId ?? p?.run_id) ?? null),
    fetch_github_agents: wrap(() => agents?.fetchGithubAgents() ?? null),
    fetch_github_agent_content: wrapWith((p: Record<string, unknown>) => agents?.fetchGithubAgentContent(p) ?? null),
    import_agent_from_github: wrapWith((p: Record<string, unknown>) => agents?.importFromGithub(p) ?? null),

    // ── Usage ─────────────────────────────────────────────────────────────────
    get_usage_stats: wrapWith((p: Record<string, unknown>) => usage?.getStats(p) ?? null),
    get_usage_by_date_range: wrapWith((p: Record<string, unknown>) => usage?.getByDateRange(p) ?? null),
    get_session_stats: wrapWith((p: Record<string, unknown>) => usage?.getSessionStats(p) ?? null),
    get_usage_details: wrapWith((p: Record<string, unknown>) => usage?.getDetails(p) ?? null),

    // ── Checkpoints ───────────────────────────────────────────────────────────
    create_checkpoint: wrapWith((p: Record<string, unknown>) => checkpoints?.create(p) ?? null),
    restore_checkpoint: wrapWith((p: Record<string, unknown>) => checkpoints?.restore(p) ?? null),
    list_checkpoints: wrapWith((p: Record<string, unknown>) => checkpoints?.list(p) ?? null),
    fork_from_checkpoint: wrapWith((p: Record<string, unknown>) => checkpoints?.forkFrom(p) ?? null),
    get_session_timeline: wrapWith((p: Record<string, unknown>) => checkpoints?.getTimeline(p) ?? null),
    update_checkpoint_settings: wrapWith((p: Record<string, unknown>) => checkpoints?.updateSettings(p) ?? null),
    get_checkpoint_diff: wrapWith((p: Record<string, unknown>) => checkpoints?.getDiff(p) ?? null),
    clear_checkpoint_manager: wrap(() => null),

    // ── Claude Binary ─────────────────────────────────────────────────────────
    get_claude_binary_path: wrap(() => claudeBinary?.getPath() ?? null),
    set_claude_binary_path: wrapWith((p: Record<string, unknown>) => claudeBinary?.setPath(p?.path as string) ?? null),
    list_claude_installations: wrap(() => claudeBinary?.listInstallations() ?? null),

    // ── MCP ───────────────────────────────────────────────────────────────────
    mcp_add: wrapWith((p: Record<string, unknown>) => mcp?.add(p) ?? null),
    mcp_list: wrap(() => mcp?.list() ?? null),
    mcp_get: wrapWith((p: Record<string, unknown>) => mcp?.get(p?.name as string) ?? null),
    mcp_remove: wrapWith((p: Record<string, unknown>) => mcp?.remove(p?.name as string) ?? null),
    mcp_add_json: wrapWith((p: Record<string, unknown>) => mcp?.addJson(p) ?? null),
    mcp_add_from_claude_desktop: wrap(() => mcp?.addFromClaudeDesktop() ?? null),
    mcp_serve: wrapWith((p: Record<string, unknown>) => mcp?.serve(p) ?? null),
    mcp_test_connection: wrapWith((p: Record<string, unknown>) => mcp?.testConnection(p?.name as string) ?? null),
    mcp_reset_project_choices: wrap(() => mcp?.resetProjectChoices() ?? null),
    mcp_get_server_status: wrap(() => mcp?.getServerStatus() ?? null),
    mcp_read_project_config: wrapWith((p: Record<string, unknown>) => mcp?.readProjectConfig(p) ?? null),
    mcp_save_project_config: wrapWith((p: Record<string, unknown>) => mcp?.saveProjectConfig(p) ?? null),

    // ── Slash Commands ────────────────────────────────────────────────────────
    slash_commands_list: wrap(() => slashCommands?.list() ?? null),
    slash_command_get: wrapWith((p: Record<string, unknown>) => slashCommands?.get((p?.commandId ?? p?.command_id) as string) ?? null),
    slash_command_save: wrapWith((p: Record<string, unknown>) => slashCommands?.save(p) ?? null),
    slash_command_delete: wrapWith((p: Record<string, unknown>) => slashCommands?.delete((p?.commandId ?? p?.command_id) as string, (p?.projectPath ?? p?.project_path) as string | undefined) ?? null),

    // ── Logging ───────────────────────────────────────────────────────────────
    log_write_batch: wrapWith((p: Record<string, unknown>) => logging?.writeBatch(p?.entries) ?? null),
    log_query: wrapWith((p: Record<string, unknown>) => logging?.query(p) ?? null),

    // ── Storage (database) ────────────────────────────────────────────────────
    storage_list_tables: wrap(() => {
      if (!database) return null;
      const rows = database.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      return rows;
    }),
    storage_read_table: wrapWith((p: Record<string, unknown>) => {
      if (!database) return null;
      const table = (p?.tableName ?? p?.table_name) as string;
      if (!table) return { rows: [], columns: [], total: 0 };
      const page = (p?.page as number) || 1;
      const pageSize = (p?.pageSize as number) || 50;
      const offset = (page - 1) * pageSize;
      const searchQuery = p?.searchQuery as string | undefined;

      try {
        // Get columns
        const colInfo = database.raw.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; type: string }[];
        const columns = colInfo.map(c => ({ name: c.name, type: c.type }));

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
        const rows = database.raw.prepare(`SELECT * FROM "${table}" ${whereClause} LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
        return { rows, columns, total: countRow.cnt, page, pageSize };
      } catch (err) {
        return { rows: [], columns: [], total: 0, error: String(err) };
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

    // ── Proxy ─────────────────────────────────────────────────────────────────
    get_proxy_settings: wrap(() => proxy?.getSettings() ?? null),
    save_proxy_settings: wrapWith((p: Record<string, unknown>) => proxy?.saveSettings(p) ?? null),
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

  for (const [channel, handler] of Object.entries(handlerMap)) {
    ipcMain.handle(channel, handler);
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
