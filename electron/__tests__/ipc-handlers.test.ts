import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getHandlerMap } from '../ipc/handlers';
import { createDatabase, type Database } from '../services/database';
import { createPermissionsIOService } from '../services/permissions-io';

// ---------------------------------------------------------------------------
// Helpers: build a `Services` object where every service method is a vi.fn
// that returns a tagged value we can assert on later. Because the handlers
// use `?? null`, we return non-null sentinels so we can tell them apart from
// the "service was not called" / "handler dispatched wrong" case.
// ---------------------------------------------------------------------------

function mockService<T extends Record<string, any>>(
  shape: readonly (keyof T)[],
): T & Record<string, ReturnType<typeof vi.fn>> {
  const obj: any = {};
  for (const key of shape) {
    obj[key] = vi.fn().mockReturnValue({ __mock: String(key) });
  }
  return obj;
}

function buildMockServices() {
  return {
    accounts: mockService([
      'list',
      'create',
      'update',
      'delete',
      'listPathRules',
      'addPathRule',
      'removePathRule',
      'resolveForProject',
      'setProjectOverride',
      'listProjectOverrides',
      'discoverAccounts',
      'explainResolution',
    ] as const),
    claude: mockService([
      'listProjects',
      'createProject',
      'getProjectSessions',
      'loadSessionHistory',
      'getHomeDirectory',
      'getSettings',
      'saveSettings',
      'getSystemPrompt',
      'saveSystemPrompt',
      'checkVersion',
      'findClaudeMdFiles',
      'readClaudeMdFile',
      'saveClaudeMdFile',
      'getHooksConfig',
      'updateHooksConfig',
      'validateHookCommand',
      'getMergedHooksConfig',
    ] as const),
    sessions: mockService([
      'start',
      'sendMessage',
      'sendStructuredMessage',
      'respondPermission',
      'stop',
      'getInfo',
      'setEffort',
      'setThinking',
      'applyPermissions',
    ] as const),
    usage: mockService([
      'getStats',
      'getByDateRange',
      'getSessionStats',
      'getDetails',
    ] as const),
    claudeBinary: mockService([
      'getPath',
      'setPath',
      'listInstallations',
    ] as const),
    mcp: mockService([
      'add',
      'list',
      'get',
      'remove',
      'addJson',
      'addFromClaudeDesktop',
      'serve',
      'testConnection',
      'resetProjectChoices',
      'getServerStatus',
      'readProjectConfig',
      'saveProjectConfig',
    ] as const),
    slashCommands: mockService([
      'list',
      'get',
      'save',
      'delete',
    ] as const),
    logging: mockService(['writeBatch', 'query'] as const),
    proxy: mockService(['getSettings', 'saveSettings'] as const),
    permissionsIO: createPermissionsIOService(),
    sdkVersion: mockService(['getReferenced', 'getLatest'] as const),
    gitWatcher: mockService(['start', 'stop'] as const),
  };
}

async function invoke(
  handlers: Record<string, any>,
  channel: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const fn = handlers[channel];
  if (!fn) throw new Error(`No handler registered for channel: ${channel}`);
  return fn(null, params);
}

// ---------------------------------------------------------------------------
// Baseline structure
// ---------------------------------------------------------------------------

describe('ipc handlers — structure', () => {
  it('returns a map of channel names to handler functions', () => {
    const handlers = getHandlerMap();
    expect(handlers).toBeDefined();
    expect(typeof handlers).toBe('object');
  });

  it('all handler values are functions', () => {
    const handlers = getHandlerMap();
    for (const [, handler] of Object.entries(handlers)) {
      expect(typeof handler).toBe('function');
    }
  });

  it('registers the full set of expected channels', () => {
    const handlers = getHandlerMap();
    const channels = new Set(Object.keys(handlers));

    const required = [
      // Accounts
      'list_accounts',
      'create_account',
      'update_account',
      'delete_account',
      'list_path_rules',
      'add_path_rule',
      'remove_path_rule',
      'resolve_account_for_project',
      'set_project_account_override',
      'list_project_overrides',
      'discover_accounts',
      'explain_account_resolution',
      // Claude
      'list_projects',
      'create_project',
      'get_project_sessions',
      'load_session_history',
      'get_home_directory',
      'get_claude_settings',
      'save_claude_settings',
      'get_system_prompt',
      'save_system_prompt',
      'check_claude_version',
      'find_claude_md_files',
      'read_claude_md_file',
      'save_claude_md_file',
      'get_hooks_config',
      'update_hooks_config',
      'validate_hook_command',
      'get_merged_hooks_config',
      // Sessions
      'session_start',
      'session_send_message',
      'session_send_structured_message',
      'session_respond_permission',
      'session_stop',
      'session_get_info',
      'session_set_effort',
      'session_set_thinking',
      'session_mcp_server_status',
      'session_plugins',
      'session_get_permissions',
      'session_update_permission',
      // Usage
      'get_usage_stats',
      // Binary
      'get_claude_binary_path',
      // MCP
      'mcp_add',
      'mcp_list',
      // Slash commands
      'slash_commands_list',
      // Logging
      'log_write_batch',
      // Storage
      'storage_list_tables',
      'storage_execute_sql',
      'get_setting',
      'save_setting',
      // Proxy
      'get_proxy_settings',
      // Git
      'get_git_branch',
      'start_git_branch_watch',
      'stop_git_branch_watch',
      // SDK version
      'get_referenced_sdk_version',
      'get_latest_sdk_version',
    ];

    for (const channel of required) {
      expect(channels.has(channel)).toBe(true);
    }
  });

  it('resolves to null for every channel when no services are provided', async () => {
    const handlers = getHandlerMap();
    // Pick a few that take params and a few that don't to exercise both wrap paths
    const samples = [
      { channel: 'list_accounts' },
      { channel: 'create_account', params: { name: 'X' } },
      { channel: 'get_home_directory' },
      { channel: 'session_start', params: { tabId: 't' } },
      { channel: 'mcp_list' },
    ];

    for (const { channel, params } of samples) {
      await expect(invoke(handlers, channel, params)).resolves.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Channel → service dispatch
// ---------------------------------------------------------------------------

describe('ipc handlers — dispatch to services', () => {
  let services: ReturnType<typeof buildMockServices>;
  let handlers: Record<string, any>;

  beforeEach(() => {
    services = buildMockServices();
    handlers = getHandlerMap(services as any);
  });

  // ── Accounts ────────────────────────────────────────────────────────────

  it('list_accounts → accounts.list()', async () => {
    const result = await invoke(handlers, 'list_accounts');
    expect(services.accounts.list).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ __mock: 'list' });
  });

  it('create_account forwards params to accounts.create', async () => {
    const params = { name: 'Work', configDir: '/tmp/work' };
    await invoke(handlers, 'create_account', params);
    expect(services.accounts.create).toHaveBeenCalledWith(params);
  });

  it('update_account forwards both id and the full params payload', async () => {
    const params = { id: 7, name: 'Updated' };
    await invoke(handlers, 'update_account', params);
    expect(services.accounts.update).toHaveBeenCalledWith(7, params);
  });

  it('delete_account pulls id off the params', async () => {
    await invoke(handlers, 'delete_account', { id: 42 });
    expect(services.accounts.delete).toHaveBeenCalledWith(42);
  });

  it('remove_path_rule accepts ruleId or id (param name normalization)', async () => {
    await invoke(handlers, 'remove_path_rule', { ruleId: 3 });
    await invoke(handlers, 'remove_path_rule', { id: 9 });
    expect(services.accounts.removePathRule).toHaveBeenNthCalledWith(1, 3);
    expect(services.accounts.removePathRule).toHaveBeenNthCalledWith(2, 9);
  });

  it('resolve_account_for_project accepts both camelCase and snake_case', async () => {
    await invoke(handlers, 'resolve_account_for_project', {
      projectPath: '/a/b',
    });
    await invoke(handlers, 'resolve_account_for_project', {
      project_path: '/c/d',
    });
    expect(services.accounts.resolveForProject).toHaveBeenNthCalledWith(1, '/a/b');
    expect(services.accounts.resolveForProject).toHaveBeenNthCalledWith(2, '/c/d');
  });

  it('set_project_account_override normalizes both case styles', async () => {
    await invoke(handlers, 'set_project_account_override', {
      projectPath: '/a',
      accountId: 1,
    });
    await invoke(handlers, 'set_project_account_override', {
      project_path: '/b',
      account_id: 2,
    });
    expect(services.accounts.setProjectOverride).toHaveBeenNthCalledWith(1, '/a', 1);
    expect(services.accounts.setProjectOverride).toHaveBeenNthCalledWith(2, '/b', 2);
  });

  it('discover_accounts and list_project_overrides are zero-arg', async () => {
    await invoke(handlers, 'discover_accounts');
    await invoke(handlers, 'list_project_overrides');
    expect(services.accounts.discoverAccounts).toHaveBeenCalledTimes(1);
    expect(services.accounts.listProjectOverrides).toHaveBeenCalledTimes(1);
  });

  // ── Claude ──────────────────────────────────────────────────────────────

  it('list_projects passes config_dir through', async () => {
    await invoke(handlers, 'list_projects', { config_dir: '/home/me/.claude' });
    expect(services.claude.listProjects).toHaveBeenCalledWith('/home/me/.claude');
  });

  it('get_project_sessions accepts both case styles', async () => {
    await invoke(handlers, 'get_project_sessions', {
      projectId: 'pid',
      projectPath: '/p',
    });
    await invoke(handlers, 'get_project_sessions', {
      project_id: 'pid2',
      project_path: '/p2',
    });
    expect(services.claude.getProjectSessions).toHaveBeenNthCalledWith(1, 'pid', '/p');
    expect(services.claude.getProjectSessions).toHaveBeenNthCalledWith(2, 'pid2', '/p2');
  });

  it('load_session_history normalizes ids', async () => {
    await invoke(handlers, 'load_session_history', {
      sessionId: 'sid',
      projectId: 'pid',
    });
    expect(services.claude.loadSessionHistory).toHaveBeenCalledWith('sid', 'pid');
  });

  it('find/read/save_claude_md_file route through the claude service', async () => {
    await invoke(handlers, 'find_claude_md_files', { projectPath: '/p' });
    await invoke(handlers, 'read_claude_md_file', { filePath: '/p/CLAUDE.md' });
    await invoke(handlers, 'save_claude_md_file', {
      filePath: '/p/CLAUDE.md',
      content: '# New',
    });

    expect(services.claude.findClaudeMdFiles).toHaveBeenCalledWith('/p');
    expect(services.claude.readClaudeMdFile).toHaveBeenCalledWith('/p/CLAUDE.md');
    expect(services.claude.saveClaudeMdFile).toHaveBeenCalledWith('/p/CLAUDE.md', '# New');
  });

  it('validate_hook_command extracts the command string', async () => {
    await invoke(handlers, 'validate_hook_command', { command: 'echo hi' });
    expect(services.claude.validateHookCommand).toHaveBeenCalledWith('echo hi');
  });

  it('save_system_prompt accepts either content or prompt', async () => {
    await invoke(handlers, 'save_system_prompt', { content: 'A' });
    await invoke(handlers, 'save_system_prompt', { prompt: 'B' });
    expect(services.claude.saveSystemPrompt).toHaveBeenNthCalledWith(1, 'A', undefined);
    expect(services.claude.saveSystemPrompt).toHaveBeenNthCalledWith(2, 'B', undefined);
  });

  // ── Sessions ────────────────────────────────────────────────────────────

  it('session_start forwards the full params object', async () => {
    const params = { tabId: 't1', projectPath: '/p', model: 'sonnet' };
    await invoke(handlers, 'session_start', params);
    expect(services.sessions.start).toHaveBeenCalledWith(params);
  });

  it('session_send_message accepts tabId or session_id + prompt or message', async () => {
    await invoke(handlers, 'session_send_message', { tabId: 't', prompt: 'hi' });
    await invoke(handlers, 'session_send_message', {
      session_id: 's',
      message: 'yo',
    });
    expect(services.sessions.sendMessage).toHaveBeenNthCalledWith(1, 't', 'hi');
    expect(services.sessions.sendMessage).toHaveBeenNthCalledWith(2, 's', 'yo');
  });

  it('session_send_structured_message forwards content array', async () => {
    const content = [{ type: 'text', text: 'hey' }];
    await invoke(handlers, 'session_send_structured_message', {
      tabId: 't',
      content,
    });
    expect(services.sessions.sendStructuredMessage).toHaveBeenCalledWith('t', content);
  });

  it('session_respond_permission forwards tabId, behavior, updatedInput, and updatedPermissions', async () => {
    await invoke(handlers, 'session_respond_permission', {
      tabId: 't',
      behavior: 'allow',
      updatedInput: { a: 1 },
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }],
    });
    expect(services.sessions.respondPermission).toHaveBeenCalledWith(
      't',
      'allow',
      { a: 1 },
      [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }],
    );
  });

  it('session_stop and session_get_info normalize the tab id', async () => {
    await invoke(handlers, 'session_stop', { tabId: 'a' });
    await invoke(handlers, 'session_get_info', { session_id: 'b' });
    expect(services.sessions.stop).toHaveBeenCalledWith('a');
    expect(services.sessions.getInfo).toHaveBeenCalledWith('b');
  });

  it('session_set_effort accepts tabId or session_id and level or effort', async () => {
    await invoke(handlers, 'session_set_effort', { tabId: 't1', level: 'high' });
    await invoke(handlers, 'session_set_effort', { session_id: 's2', effort: 'low' });
    expect(services.sessions.setEffort).toHaveBeenNthCalledWith(1, 't1', 'high');
    expect(services.sessions.setEffort).toHaveBeenNthCalledWith(2, 's2', 'low');
  });

  it('session_set_thinking accepts tabId or session_id and config or thinking', async () => {
    const adaptive = { type: 'adaptive' };
    const enabled = { type: 'enabled', budgetTokens: 10000 };
    await invoke(handlers, 'session_set_thinking', { tabId: 't1', config: adaptive });
    await invoke(handlers, 'session_set_thinking', { session_id: 's2', thinking: enabled });
    expect(services.sessions.setThinking).toHaveBeenNthCalledWith(1, 't1', adaptive);
    expect(services.sessions.setThinking).toHaveBeenNthCalledWith(2, 's2', enabled);
  });

  // ── Session Permissions (file-based) ────────────────────────────────────

  it('session_get_permissions reads from user, project, and local settings files', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-perm-test-'));
    const projDir = path.join(tmpDir, 'project');
    fs.mkdirSync(path.join(projDir, '.claude'), { recursive: true });

    // Write user settings
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'], deny: ['Write(/etc/*)'] } }));
    // Write project settings
    fs.writeFileSync(path.join(projDir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Read(*)'] } }));
    // Write local settings
    fs.writeFileSync(path.join(projDir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Edit(*)'], deny: [] } }));

    const result = await invoke(handlers, 'session_get_permissions', { configDir: tmpDir, projectPath: projDir }) as any[];
    expect(result).toHaveLength(3);
    expect(result[0].scope).toBe('user');
    expect(result[0].allow).toContain('Bash(*)');
    expect(result[0].deny).toContain('Write(/etc/*)');
    expect(result[1].scope).toBe('project');
    expect(result[1].allow).toContain('Read(*)');
    expect(result[2].scope).toBe('local');
    expect(result[2].allow).toContain('Edit(*)');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('session_update_permission adds a rule to the correct file', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-perm-upd-'));
    const projDir = path.join(tmpDir, 'project');
    fs.mkdirSync(path.join(projDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(git:*)'] } }));

    await invoke(handlers, 'session_update_permission', {
      configDir: tmpDir,
      projectPath: projDir,
      scope: 'local',
      action: 'add',
      behavior: 'allow',
      rule: 'Bash(npm:*)',
    });

    const updated = JSON.parse(fs.readFileSync(path.join(projDir, '.claude', 'settings.local.json'), 'utf-8'));
    expect(updated.permissions.allow).toContain('Bash(git:*)');
    expect(updated.permissions.allow).toContain('Bash(npm:*)');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('session_update_permission pushes the effective rule lists into the live session when tabId is provided', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-perm-push-'));
    const projDir = path.join(tmpDir, 'project');
    fs.mkdirSync(path.join(projDir, '.claude'), { recursive: true });
    // Pre-existing local rule, plus a user rule to prove we send the union.
    fs.writeFileSync(
      path.join(projDir, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Edit(/.claude/commands/*)'] } }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git:*)'], deny: ['Bash(rm -rf:*)'] } }),
    );

    await invoke(handlers, 'session_update_permission', {
      tabId: 'tab-live',
      configDir: tmpDir,
      projectPath: projDir,
      scope: 'local',
      action: 'add',
      behavior: 'allow',
      rule: 'Bash(npm:*)',
    });

    expect(services.sessions.applyPermissions).toHaveBeenCalledTimes(1);
    const [tabId, perms] = services.sessions.applyPermissions.mock.calls[0];
    expect(tabId).toBe('tab-live');
    // Allow list = union of user + local (post-write), deduped.
    expect((perms as any).allow.sort()).toEqual(
      ['Bash(git:*)', 'Bash(npm:*)', 'Edit(/.claude/commands/*)'].sort(),
    );
    expect((perms as any).deny).toEqual(['Bash(rm -rf:*)']);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('session_update_permission does not call applyPermissions when no tabId is provided', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-perm-notab-'));
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({}));

    await invoke(handlers, 'session_update_permission', {
      // No tabId — settings panel rather than session sidebar
      configDir: tmpDir,
      projectPath: '',
      scope: 'user',
      action: 'add',
      behavior: 'allow',
      rule: 'Read(*)',
    });

    expect(services.sessions.applyPermissions).not.toHaveBeenCalled();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('session_update_permission removes a rule', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-perm-rm-'));
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)', 'Read(*)'] } }));

    await invoke(handlers, 'session_update_permission', {
      configDir: tmpDir,
      projectPath: '',
      scope: 'user',
      action: 'remove',
      behavior: 'allow',
      rule: 'Bash(*)',
    });

    const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf-8'));
    expect(updated.permissions.allow).toEqual(['Read(*)']);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('add_path_rule forwards the rule params', async () => {
    const rule = { accountId: 1, pathPrefix: '/work' };
    await invoke(handlers, 'add_path_rule', rule);
    expect(services.accounts.addPathRule).toHaveBeenCalledWith(rule);
  });

  it('claude hooks + settings channels dispatch without params', async () => {
    await invoke(handlers, 'get_claude_settings');
    await invoke(handlers, 'save_claude_settings', { theme: 'dark' });
    await invoke(handlers, 'get_system_prompt');
    await invoke(handlers, 'check_claude_version');
    await invoke(handlers, 'get_hooks_config');
    await invoke(handlers, 'update_hooks_config', { hooks: {} });
    await invoke(handlers, 'get_merged_hooks_config');
    await invoke(handlers, 'create_project', { path: '/p' });

    expect(services.claude.getSettings).toHaveBeenCalledTimes(1);
    expect(services.claude.saveSettings).toHaveBeenCalled();
    expect(services.claude.getSystemPrompt).toHaveBeenCalledTimes(1);
    expect(services.claude.checkVersion).toHaveBeenCalledTimes(1);
    expect(services.claude.getHooksConfig).toHaveBeenCalledTimes(1);
    expect(services.claude.updateHooksConfig).toHaveBeenCalled();
    expect(services.claude.getMergedHooksConfig).toHaveBeenCalledTimes(1);
    expect(services.claude.createProject).toHaveBeenCalled();
  });

  // ── Usage ───────────────────────────────────────────────────────────────

  it('usage channels forward the param object', async () => {
    await invoke(handlers, 'get_usage_stats', { days: 7 });
    await invoke(handlers, 'get_usage_by_date_range', {
      start_date: '2026-01-01',
      end_date: '2026-01-31',
    });
    await invoke(handlers, 'get_session_stats', { order: 'asc' });
    await invoke(handlers, 'get_usage_details', { limit: 10 });

    expect(services.usage.getStats).toHaveBeenCalledWith({ days: 7 });
    expect(services.usage.getByDateRange).toHaveBeenCalledWith({
      start_date: '2026-01-01',
      end_date: '2026-01-31',
    });
    expect(services.usage.getSessionStats).toHaveBeenCalledWith({ order: 'asc' });
    expect(services.usage.getDetails).toHaveBeenCalledWith({ limit: 10 });
  });

  // ── Claude binary ───────────────────────────────────────────────────────

  it('claude binary channels route through the service', async () => {
    await invoke(handlers, 'get_claude_binary_path');
    await invoke(handlers, 'set_claude_binary_path', { path: '/usr/bin/claude' });
    await invoke(handlers, 'list_claude_installations');

    expect(services.claudeBinary.getPath).toHaveBeenCalledTimes(1);
    expect(services.claudeBinary.setPath).toHaveBeenCalledWith('/usr/bin/claude');
    expect(services.claudeBinary.listInstallations).toHaveBeenCalledTimes(1);
  });

  // ── MCP ─────────────────────────────────────────────────────────────────

  it('mcp channels route through the service', async () => {
    await invoke(handlers, 'mcp_add', { name: 'srv' });
    await invoke(handlers, 'mcp_list');
    await invoke(handlers, 'mcp_get', { name: 'srv' });
    await invoke(handlers, 'mcp_remove', { name: 'srv' });
    await invoke(handlers, 'mcp_add_json', { name: 'x', json: '{}' });
    await invoke(handlers, 'mcp_add_from_claude_desktop');
    await invoke(handlers, 'mcp_serve', {});
    await invoke(handlers, 'mcp_test_connection', { name: 'srv' });
    await invoke(handlers, 'mcp_reset_project_choices');
    await invoke(handlers, 'mcp_get_server_status');
    await invoke(handlers, 'mcp_read_project_config');
    await invoke(handlers, 'mcp_save_project_config', { path: '/p' });

    expect(services.mcp.add).toHaveBeenCalledWith({ name: 'srv' });
    expect(services.mcp.list).toHaveBeenCalledWith(undefined);
    expect(services.mcp.get).toHaveBeenCalledWith('srv', undefined);
    expect(services.mcp.remove).toHaveBeenCalledWith('srv', undefined);
    expect(services.mcp.addJson).toHaveBeenCalled();
    expect(services.mcp.addFromClaudeDesktop).toHaveBeenCalledWith(undefined, undefined);
    expect(services.mcp.serve).toHaveBeenCalledTimes(1);
    expect(services.mcp.testConnection).toHaveBeenCalledWith('srv', undefined);
    expect(services.mcp.resetProjectChoices).toHaveBeenCalledTimes(1);
    expect(services.mcp.getServerStatus).toHaveBeenCalledWith(undefined);
    expect(services.mcp.readProjectConfig).toHaveBeenCalledWith(undefined);
    expect(services.mcp.saveProjectConfig).toHaveBeenCalled();
  });

  // ── Slash commands ──────────────────────────────────────────────────────

  it('slash command channels normalize commandId', async () => {
    await invoke(handlers, 'slash_commands_list');
    await invoke(handlers, 'slash_command_get', { commandId: 'x' });
    await invoke(handlers, 'slash_command_get', { command_id: 'y' });
    await invoke(handlers, 'slash_command_save', { id: 'z' });
    await invoke(handlers, 'slash_command_delete', { commandId: 'x' });

    expect(services.slashCommands.list).toHaveBeenCalledWith(undefined, undefined);
    expect(services.slashCommands.get).toHaveBeenNthCalledWith(1, 'x', undefined);
    expect(services.slashCommands.get).toHaveBeenNthCalledWith(2, 'y', undefined);
    expect(services.slashCommands.save).toHaveBeenCalled();
    expect(services.slashCommands.delete).toHaveBeenCalledWith('x', undefined, undefined);
  });

  // ── Logging ─────────────────────────────────────────────────────────────

  it('log_write_batch pulls entries off the params', async () => {
    const entries = [{ level: 'info', message: 'hi' }];
    await invoke(handlers, 'log_write_batch', { entries });
    expect(services.logging.writeBatch).toHaveBeenCalledWith(entries);
  });

  it('log_query forwards full params', async () => {
    const params = { level: 'error', limit: 10 };
    await invoke(handlers, 'log_query', params);
    expect(services.logging.query).toHaveBeenCalledWith(params);
  });

  // ── Git Branch ──────────────────────────────────────────────────────────

  it('get_git_branch returns the current branch for a git repo', async () => {
    const result = await invoke(handlers, 'get_git_branch', { projectPath: process.cwd() }) as string | null;
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);
  });

  it('get_git_branch accepts snake_case project_path param', async () => {
    const result = await invoke(handlers, 'get_git_branch', { project_path: process.cwd() });
    expect(typeof result).toBe('string');
  });

  it('get_git_branch returns null when projectPath is missing', async () => {
    const result = await invoke(handlers, 'get_git_branch', {});
    expect(result).toBeNull();
  });

  it('get_git_branch returns null for a non-git directory', async () => {
    const os = await import('node:os');
    const result = await invoke(handlers, 'get_git_branch', { projectPath: os.tmpdir() });
    expect(result).toBeNull();
  });

  // ── Proxy ───────────────────────────────────────────────────────────────

  it('proxy channels route through the service', async () => {
    await invoke(handlers, 'get_proxy_settings');
    await invoke(handlers, 'save_proxy_settings', { enabled: true });

    expect(services.proxy.getSettings).toHaveBeenCalledTimes(1);
    expect(services.proxy.saveSettings).toHaveBeenCalledWith({ enabled: true });
  });

  // ── SDK version ─────────────────────────────────────────────────────────

  it('get_referenced_sdk_version routes through the service', async () => {
    services.sdkVersion.getReferenced.mockResolvedValueOnce('1.2.3');
    const result = await invoke(handlers, 'get_referenced_sdk_version');
    expect(result).toBe('1.2.3');
    expect(services.sdkVersion.getReferenced).toHaveBeenCalledTimes(1);
  });

  it('get_latest_sdk_version routes through the service', async () => {
    services.sdkVersion.getLatest.mockResolvedValueOnce('2.0.0');
    const result = await invoke(handlers, 'get_latest_sdk_version');
    expect(result).toBe('2.0.0');
    expect(services.sdkVersion.getLatest).toHaveBeenCalledTimes(1);
  });

  // ── Git watcher ─────────────────────────────────────────────────────────

  it('start_git_branch_watch forwards the project path and returns the service result', async () => {
    services.gitWatcher.start.mockResolvedValueOnce({ watchId: 'w-1', branch: 'main' });
    const result = await invoke(handlers, 'start_git_branch_watch', { projectPath: '/tmp/x' });
    expect(result).toEqual({ watchId: 'w-1', branch: 'main' });
    expect(services.gitWatcher.start).toHaveBeenCalledWith('/tmp/x');
  });

  it('start_git_branch_watch accepts snake_case project_path param', async () => {
    services.gitWatcher.start.mockResolvedValueOnce({ watchId: 'w-2', branch: null });
    await invoke(handlers, 'start_git_branch_watch', { project_path: '/tmp/y' });
    expect(services.gitWatcher.start).toHaveBeenCalledWith('/tmp/y');
  });

  it('start_git_branch_watch returns null when projectPath is missing', async () => {
    const result = await invoke(handlers, 'start_git_branch_watch', {});
    expect(result).toBeNull();
    expect(services.gitWatcher.start).not.toHaveBeenCalled();
  });

  it('stop_git_branch_watch routes through the service', async () => {
    await invoke(handlers, 'stop_git_branch_watch', { watchId: 'w-1' });
    expect(services.gitWatcher.stop).toHaveBeenCalledWith('w-1');
  });

  it('stop_git_branch_watch returns null when watchId is missing', async () => {
    const result = await invoke(handlers, 'stop_git_branch_watch', {});
    expect(result).toBeNull();
    expect(services.gitWatcher.stop).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error wrapping — wrap / wrapWith rethrow errors as Error instances
// ---------------------------------------------------------------------------

describe('ipc handlers — error propagation', () => {
  it('wraps thrown Error objects and preserves the message', async () => {
    const services = buildMockServices();
    services.accounts.list.mockImplementationOnce(() => {
      throw new Error('kaboom');
    });
    const handlers = getHandlerMap(services as any);

    await expect(invoke(handlers, 'list_accounts')).rejects.toThrow('kaboom');
  });

  it('wraps thrown non-Error values as Error with string message', async () => {
    const services = buildMockServices();
    services.accounts.list.mockImplementationOnce(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain string';
    });
    const handlers = getHandlerMap(services as any);

    await expect(invoke(handlers, 'list_accounts')).rejects.toThrow('plain string');
  });

  it('awaits async service methods and propagates rejections', async () => {
    const services = buildMockServices();
    services.claude.listProjects.mockImplementationOnce(async () => {
      throw new Error('async boom');
    });
    const handlers = getHandlerMap(services as any);

    await expect(
      invoke(handlers, 'list_projects', { config_dir: '/x' }),
    ).rejects.toThrow('async boom');
  });
});

// ---------------------------------------------------------------------------
// Storage channels — these use the real `database` dependency rather than a
// mocked service because the handler contains all the SQL inline.
// ---------------------------------------------------------------------------

describe('ipc handlers — storage channels', () => {
  let db: Database;
  let handlers: Record<string, any>;

  beforeEach(() => {
    db = createDatabase(':memory:');
    // Seed a simple table
    db.raw.exec(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        value TEXT
      );
      INSERT INTO items (name, value) VALUES ('alpha', 'one'), ('beta', 'two'), ('alphabet', 'three');
    `);
    handlers = getHandlerMap({ database: db });
  });

  it('storage_list_tables returns all user tables', async () => {
    const rows = (await invoke(handlers, 'storage_list_tables')) as {
      name: string;
    }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain('items');
    expect(names).toContain('accounts');
  });

  it('storage_read_table returns rows + columns + total', async () => {
    const result = (await invoke(handlers, 'storage_read_table', {
      tableName: 'items',
      page: 1,
      pageSize: 10,
    })) as any;

    expect(result.total_rows).toBe(3);
    expect(result.rows).toHaveLength(3);
    expect(result.columns.map((c: any) => c.name)).toEqual(['id', 'name', 'value']);
  });

  it('storage_read_table supports pagination', async () => {
    const page1 = (await invoke(handlers, 'storage_read_table', {
      tableName: 'items',
      page: 1,
      pageSize: 2,
    })) as any;
    const page2 = (await invoke(handlers, 'storage_read_table', {
      tableName: 'items',
      page: 2,
      pageSize: 2,
    })) as any;

    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(1);
  });

  it('storage_read_table filters by searchQuery across text columns', async () => {
    const result = (await invoke(handlers, 'storage_read_table', {
      tableName: 'items',
      searchQuery: 'alpha',
    })) as any;
    // Should match both "alpha" and "alphabet"
    expect(result.total_rows).toBe(2);
  });

  it('storage_read_table handles missing table name gracefully', async () => {
    const result = (await invoke(handlers, 'storage_read_table', {})) as any;
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual([]);
    expect(result.total_rows).toBe(0);
  });

  it('storage_read_table returns error shape for a nonexistent table', async () => {
    const result = (await invoke(handlers, 'storage_read_table', {
      tableName: 'does_not_exist',
    })) as any;
    expect(result.total_rows).toBe(0);
    expect(typeof result.error).toBe('string');
  });

  it('storage_insert_row adds a row and storage_read_table sees it', async () => {
    await invoke(handlers, 'storage_insert_row', {
      tableName: 'items',
      values: { name: 'gamma', value: 'four' },
    });

    const result = (await invoke(handlers, 'storage_read_table', {
      tableName: 'items',
    })) as any;
    expect(result.total_rows).toBe(4);
  });

  it('storage_update_row modifies an existing row', async () => {
    await invoke(handlers, 'storage_update_row', {
      tableName: 'items',
      primaryKeyValues: { id: 1 },
      updates: { value: 'ONE!' },
    });

    const row = db.raw.prepare('SELECT * FROM items WHERE id = 1').get() as any;
    expect(row.value).toBe('ONE!');
  });

  it('storage_delete_row removes the target row', async () => {
    await invoke(handlers, 'storage_delete_row', {
      tableName: 'items',
      primaryKeyValues: { id: 2 },
    });

    const row = db.raw.prepare('SELECT * FROM items WHERE id = 2').get();
    expect(row).toBeUndefined();
  });

  it('storage_execute_sql runs arbitrary queries', async () => {
    const rows = (await invoke(handlers, 'storage_execute_sql', {
      query: 'SELECT name FROM items ORDER BY id',
    })) as any[];
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'beta', 'alphabet']);
  });

  it('storage channels are null-safe when database is not wired', async () => {
    const emptyHandlers = getHandlerMap({});
    await expect(invoke(emptyHandlers, 'storage_list_tables')).resolves.toBeNull();
    await expect(
      invoke(emptyHandlers, 'storage_insert_row', {
        tableName: 'x',
        values: { a: 1 },
      }),
    ).resolves.toBeNull();
  });

  it('get_setting / save_setting round-trip via the database', async () => {
    await invoke(handlers, 'save_setting', { key: 'theme', value: 'dark' });
    const value = await invoke(handlers, 'get_setting', { key: 'theme' });
    expect(value).toBe('dark');
  });

  it('storage_reset_database is a stubbed no-op', async () => {
    const result = await invoke(handlers, 'storage_reset_database');
    expect(result).toBeNull();
  });

  it('missing required params on update/delete/insert resolve to null', async () => {
    await expect(
      invoke(handlers, 'storage_update_row', { tableName: 'items' }),
    ).resolves.toBeNull();
    await expect(
      invoke(handlers, 'storage_delete_row', { tableName: 'items' }),
    ).resolves.toBeNull();
    await expect(
      invoke(handlers, 'storage_insert_row', { tableName: 'items' }),
    ).resolves.toBeNull();
    await expect(invoke(handlers, 'storage_execute_sql', {})).resolves.toBeNull();
  });
});
