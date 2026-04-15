# MCP & SlashCommands Account Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MCP and SlashCommands services account-aware by accepting `configDir` per-call instead of per-construction, so multi-account users get the right config for their active account.

**Architecture:** Both services keep their factory pattern with a `defaultConfigDir` fallback. Every method that reads/writes account-scoped config gains an optional `configDir` parameter. IPC handlers extract `configDir` from request params. Renderer components pass the active account's `configDir` through.

**Tech Stack:** TypeScript, Electron IPC, Vitest

---

## File Map

| Action | File | Change |
|--------|------|--------|
| Modify | `electron/services/mcp.ts` | Add `configDir?` to every account-scoped method |
| Modify | `electron/services/slash-commands.ts` | Add `configDir?` to every method |
| Modify | `electron/ipc/handlers.ts` | Extract and pass `configDir` in MCP + slash command handlers |
| Modify | `electron/__tests__/mcp.test.ts` | Add multi-account isolation tests |
| Modify | `electron/__tests__/slash-commands.test.ts` | Add multi-account isolation tests |
| Modify | `src/lib/api.ts` | Add `configDir?` to MCP and slash command API wrappers |
| Modify | `src/components/MCPManager.tsx` | Accept and pass `configDir` prop |
| Modify | `src/components/MCPServerList.tsx` | Accept and pass `configDir` prop |
| Modify | `src/components/MCPAddServer.tsx` | Accept and pass `configDir` prop |
| Modify | `src/components/MCPImportExport.tsx` | Accept and pass `configDir` prop |
| Modify | `src/components/SlashCommandsManager.tsx` | Accept and pass `configDir` prop |
| Modify | `src/components/SlashCommandPicker.tsx` | Accept and pass `configDir` prop |
| Modify | `src/components/TabContent.tsx` | Resolve `configDir` and pass to MCP/SlashCommands components |
| Modify | `src/components/ClaudeCodeSession.tsx` | Pass `configDir` to SlashCommandsManager |

---

## Task 1: MCP Service — per-call configDir

**Files:**
- Modify: `electron/services/mcp.ts`
- Test: `electron/__tests__/mcp.test.ts`

- [ ] **Step 1: Write the failing test for multi-account isolation**

Add to `electron/__tests__/mcp.test.ts` at the end of the describe block:

```typescript
  describe('multi-account isolation', () => {
    let accountADir: string;
    let accountBDir: string;

    beforeEach(() => {
      accountADir = fs.mkdtempSync(path.join(os.tmpdir(), 'greychrist-mcp-acctA-'));
      accountBDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greychrist-mcp-acctB-'));
      fs.writeFileSync(path.join(accountADir, 'settings.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');
      fs.writeFileSync(path.join(accountBDir, 'settings.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');
    });

    afterEach(() => {
      fs.rmSync(accountADir, { recursive: true, force: true });
      fs.rmSync(accountBDir, { recursive: true, force: true });
    });

    it('list with configDir reads from the specified account', () => {
      // Add a server to account A directly
      const settingsA = { mcpServers: { 'server-a': { command: 'node', args: ['a.js'] } } };
      fs.writeFileSync(path.join(accountADir, 'settings.json'), JSON.stringify(settingsA), 'utf-8');

      const fromA = mcp.list(accountADir);
      const fromB = mcp.list(accountBDir);
      const fromDefault = mcp.list();

      expect(fromA).toHaveLength(1);
      expect(fromA[0].name).toBe('server-a');
      expect(fromB).toHaveLength(0);
      expect(fromDefault).toHaveLength(0); // default configDir has no servers
    });

    it('add with configDir writes to the specified account', () => {
      mcp.add({ name: 'only-in-b', command: 'python3', configDir: accountBDir });

      expect(mcp.list(accountADir)).toHaveLength(0);
      expect(mcp.list(accountBDir)).toHaveLength(1);
      expect(mcp.list(accountBDir)[0].name).toBe('only-in-b');
    });

    it('remove with configDir removes from the specified account', () => {
      mcp.add({ name: 'to-remove', command: 'node', configDir: accountADir });
      expect(mcp.list(accountADir)).toHaveLength(1);

      mcp.remove('to-remove', accountADir);
      expect(mcp.list(accountADir)).toHaveLength(0);
    });

    it('get with configDir reads from the specified account', () => {
      mcp.add({ name: 'specific', command: 'deno', configDir: accountBDir });

      const server = mcp.get('specific', accountBDir);
      expect(server.command).toBe('deno');

      expect(() => mcp.get('specific', accountADir)).toThrow(/not found/);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/__tests__/mcp.test.ts -t "multi-account" 2>&1 | tail -10`

Expected: FAIL — `list` doesn't accept arguments, `add` params don't have `configDir`.

- [ ] **Step 3: Implement per-call configDir in mcp.ts**

Replace the current implementation. The key changes:
1. `settingsPath` closure constant → `getSettingsPath(configDir?)` function
2. `getMcpServers()` → `getMcpServers(configDir?)`
3. `saveMcpServers(servers)` → `saveMcpServers(servers, configDir?)`
4. Every public method gains optional `configDir?` param and passes it through

```typescript
export function createMCPService(defaultConfigDir: string): MCPService {

  function getSettingsPath(configDir?: string): string {
    return path.join(configDir ?? defaultConfigDir, 'settings.json');
  }

  function getMcpServers(configDir?: string): Record<string, MCPServerEntry> {
    const settings = readSettings(getSettingsPath(configDir));
    return (settings.mcpServers as Record<string, MCPServerEntry>) ?? {};
  }

  function saveMcpServers(servers: Record<string, MCPServerEntry>, configDir?: string): void {
    const sp = getSettingsPath(configDir);
    const settings = readSettings(sp);
    settings.mcpServers = servers;
    writeSettings(sp, settings);
  }

  function list(configDir?: string): any[] {
    const servers = getMcpServers(configDir);
    return Object.entries(servers).map(([name, config]) => ({ ...config, name }));
  }

  function get(name: string, configDir?: string): any {
    const servers = getMcpServers(configDir);
    const config = servers[name];
    if (!config) throw new Error(`MCP server not found: ${name}`);
    return { ...config, name };
  }

  function add(params: any): any {
    const { name, configDir: cd, ...config } = params;
    if (!name) throw new Error('MCP server name is required');
    const servers = getMcpServers(cd);
    servers[name] = config as MCPServerEntry;
    saveMcpServers(servers, cd);
    return { name, ...config };
  }

  function remove(name: string, configDir?: string): string {
    const servers = getMcpServers(configDir);
    if (!(name in servers)) throw new Error(`MCP server not found: ${name}`);
    delete servers[name];
    saveMcpServers(servers, configDir);
    return `Removed MCP server: ${name}`;
  }

  function addJson(params: any): any {
    const { name, json, configDir: cd } = params;
    let config: any;
    try {
      config = typeof json === 'string' ? JSON.parse(json) : json;
    } catch {
      throw new Error('Invalid JSON configuration');
    }
    return add({ name, ...config, configDir: cd });
  }

  function addFromClaudeDesktop(scope?: string, configDir?: string): any {
    return { imported: 0, scope: scope ?? 'global', message: 'Claude Desktop import not yet implemented' };
  }

  function serve(): string {
    return 'MCP serve not yet implemented';
  }

  function testConnection(name: string, configDir?: string): string {
    try {
      get(name, configDir);
      return `Connection test for "${name}": stub response (not yet implemented)`;
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  function resetProjectChoices(): string {
    return 'Project choices reset (not yet implemented)';
  }

  function getServerStatus(configDir?: string): Record<string, any> {
    const servers = getMcpServers(configDir);
    const status: Record<string, any> = {};
    for (const name of Object.keys(servers)) {
      status[name] = { status: 'unknown', pid: null };
    }
    return status;
  }

  function readProjectConfig(projectPath: string): any {
    const configPath = path.join(projectPath, '.mcp.json');
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return { mcpServers: {} };
    }
  }

  function saveProjectConfig(projectPath: string, config: any): string {
    const configPath = path.join(projectPath, '.mcp.json');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return `Saved project MCP config to ${configPath}`;
  }

  return {
    add, list, get, remove, addJson, addFromClaudeDesktop,
    serve, testConnection, resetProjectChoices, getServerStatus,
    readProjectConfig, saveProjectConfig,
  };
}
```

Also update the `MCPService` interface at the top of the file:

```typescript
export interface MCPService {
  add(params: any): any;
  list(configDir?: string): any[];
  get(name: string, configDir?: string): any;
  remove(name: string, configDir?: string): string;
  addJson(params: any): any;
  addFromClaudeDesktop(scope?: string, configDir?: string): any;
  serve(): string;
  testConnection(name: string, configDir?: string): string;
  resetProjectChoices(): string;
  getServerStatus(configDir?: string): Record<string, any>;
  readProjectConfig(projectPath: string): any;
  saveProjectConfig(projectPath: string, config: any): string;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/__tests__/mcp.test.ts 2>&1 | tail -10`

Expected: ALL pass (existing + new multi-account tests).

- [ ] **Step 5: Commit**

```bash
git add electron/services/mcp.ts electron/__tests__/mcp.test.ts
git commit -m "feat: make MCP service account-aware with per-call configDir"
```

---

## Task 2: SlashCommands Service — per-call configDir

**Files:**
- Modify: `electron/services/slash-commands.ts`
- Test: `electron/__tests__/slash-commands.test.ts`

- [ ] **Step 1: Write the failing test for multi-account isolation**

Add to `electron/__tests__/slash-commands.test.ts` at the end of the describe block:

```typescript
  describe('multi-account isolation', () => {
    let accountADir: string;
    let accountBDir: string;

    beforeEach(() => {
      accountADir = fs.mkdtempSync(path.join(os.tmpdir(), 'greychrist-slash-acctA-'));
      accountBDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greychrist-slash-acctB-'));
      fs.mkdirSync(path.join(accountADir, 'commands'), { recursive: true });
      fs.mkdirSync(path.join(accountBDir, 'commands'), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(accountADir, { recursive: true, force: true });
      fs.rmSync(accountBDir, { recursive: true, force: true });
    });

    it('list with configDir reads commands from the specified account', () => {
      // Create a command in account A
      service.save({
        scope: 'user',
        name: 'cmd-a',
        namespace: 'test',
        content: 'From account A',
        description: 'Account A command',
        allowedTools: '',
        configDir: accountADir,
      });

      const fromA = service.list(undefined, accountADir);
      const fromB = service.list(undefined, accountBDir);

      expect(fromA).toHaveLength(1);
      expect(fromA[0].name).toBe('cmd-a');
      expect(fromB).toHaveLength(0);
    });

    it('save with configDir writes to the specified account', () => {
      service.save({
        scope: 'user',
        name: 'cmd-b',
        namespace: 'test',
        content: 'From account B',
        description: 'Account B command',
        allowedTools: '',
        configDir: accountBDir,
      });

      // Verify the file is in accountBDir, not accountADir
      expect(fs.existsSync(path.join(accountBDir, 'commands', 'cmd-b.md'))).toBe(true);
      expect(fs.existsSync(path.join(accountADir, 'commands', 'cmd-b.md'))).toBe(false);
    });

    it('get with configDir reads from the specified account', () => {
      service.save({
        scope: 'user',
        name: 'findme',
        namespace: 'test',
        content: 'Here I am',
        description: 'Findable',
        allowedTools: '',
        configDir: accountADir,
      });

      const found = service.get('user:test:findme', accountADir);
      expect(found.name).toBe('findme');

      expect(() => service.get('user:test:findme', accountBDir)).toThrow(/not found/);
    });

    it('delete with configDir removes from the specified account', () => {
      service.save({
        scope: 'user',
        name: 'doomed',
        namespace: 'test',
        content: 'Goodbye',
        description: 'To be deleted',
        allowedTools: '',
        configDir: accountADir,
      });

      expect(service.list(undefined, accountADir)).toHaveLength(1);
      service.delete('user:test:doomed', undefined, accountADir);
      expect(service.list(undefined, accountADir)).toHaveLength(0);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/__tests__/slash-commands.test.ts -t "multi-account" 2>&1 | tail -10`

Expected: FAIL — `list` takes 1 arg, `save` params don't have `configDir`, etc.

- [ ] **Step 3: Implement per-call configDir in slash-commands.ts**

Key changes:
1. `globalCommandsDir` closure constant → `getCommandsDir(configDir?)` function
2. Every method gains optional `configDir?` parameter
3. `SaveParams` gains `configDir?: string`

Update the interfaces:

```typescript
export interface SaveParams {
  scope: string;
  name: string;
  namespace: string;
  content: string;
  description: string;
  allowedTools: string;
  projectPath?: string;
  configDir?: string;
}

export interface SlashCommandsService {
  list(projectPath?: string, configDir?: string): SlashCommand[];
  get(commandId: string, configDir?: string): SlashCommand;
  save(params: SaveParams): SlashCommand;
  delete(commandId: string, projectPath?: string, configDir?: string): string;
}
```

Update the factory:

```typescript
export function createSlashCommandsService(defaultConfigDir: string): SlashCommandsService {

  function getCommandsDir(configDir?: string): string {
    return path.join(configDir ?? defaultConfigDir, 'commands');
  }

  function list(projectPath?: string, configDir?: string): SlashCommand[] {
    const commands: SlashCommand[] = [];
    commands.push(...scanDirectory(getCommandsDir(configDir), 'user', 'user'));
    if (projectPath) {
      const projectCommandsDir = path.join(projectPath, '.claude', 'commands');
      commands.push(...scanDirectory(projectCommandsDir, 'project', 'project'));
    }
    return commands;
  }

  function get(commandId: string, configDir?: string): SlashCommand {
    const parts = commandId.split(':');
    if (parts.length < 3) throw new Error(`Invalid command id: ${commandId}`);
    const [scope, namespace, name] = parts;

    const dir = getCommandsDir(configDir);
    const filePath = path.join(dir, `${name}.md`);
    const cmd = commandFromFile(filePath, scope, namespace);
    if (!cmd) throw new Error(`Command not found: ${commandId}`);
    return cmd;
  }

  function save(params: SaveParams): SlashCommand {
    const { scope, name, namespace, content, description, allowedTools, projectPath, configDir } = params;

    let dir: string;
    if (scope === 'project' && projectPath) {
      dir = path.join(projectPath, '.claude', 'commands');
    } else {
      dir = getCommandsDir(configDir);
    }

    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${name}.md`);
    const fileContent = renderFrontmatter({ description, allowed_tools: allowedTools, content });
    fs.writeFileSync(filePath, fileContent, 'utf-8');

    const id = `${scope}:${namespace}:${name}`;
    return { id, name, namespace, scope, content, description, allowed_tools: allowedTools, file_path: filePath };
  }

  function deleteCommand(commandId: string, projectPath?: string, configDir?: string): string {
    const parts = commandId.split(':');
    if (parts.length < 3) throw new Error(`Invalid command id: ${commandId}`);
    const [scope, , name] = parts;

    let filePath: string;
    if (scope === 'project' && projectPath) {
      filePath = path.join(projectPath, '.claude', 'commands', `${name}.md`);
    } else {
      filePath = path.join(getCommandsDir(configDir), `${name}.md`);
    }

    try { fs.unlinkSync(filePath); } catch (e: any) {
      throw new Error(`Could not delete command: ${e.message}`);
    }
    return `Deleted command: ${commandId}`;
  }

  return { list, get, save, delete: deleteCommand };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/__tests__/slash-commands.test.ts 2>&1 | tail -10`

Expected: ALL pass.

- [ ] **Step 5: Commit**

```bash
git add electron/services/slash-commands.ts electron/__tests__/slash-commands.test.ts
git commit -m "feat: make SlashCommands service account-aware with per-call configDir"
```

---

## Task 3: IPC handler wiring

**Files:**
- Modify: `electron/ipc/handlers.ts`

- [ ] **Step 1: Update MCP handlers to extract and pass configDir**

In `electron/ipc/handlers.ts`, replace the MCP handler block (lines ~363-374):

```typescript
    // MCP
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
```

Note: `mcp_add` and `mcp_add_json` pass the whole `p` object which now contains `configDir` — the service destructures it internally. `mcp_list` changes from `wrap(() =>` to `wrapWith((p) =>` to accept params.

- [ ] **Step 2: Update SlashCommands handlers to extract and pass configDir**

Replace the slash commands handler block (lines ~377-380):

```typescript
    // Slash Commands
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
```

- [ ] **Step 3: Run check and tests**

Run: `npm run check && npm test`

Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add electron/ipc/handlers.ts
git commit -m "feat: wire configDir through MCP and SlashCommands IPC handlers"
```

---

## Task 4: Renderer API — add configDir to typed wrappers

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Update MCP API methods**

Find each MCP method in `api.ts` and add optional `configDir?` parameter. Pass it through in the `apiCall` params object.

`mcpList`:
```typescript
  async mcpList(configDir?: string): Promise<MCPServer[]> {
    try {
      const result = await apiCall<MCPServer[]>("mcp_list", { configDir });
      return result;
    } catch (error) {
      console.error("API: Failed to list MCP servers:", error);
      throw error;
    }
  },
```

`mcpAdd` — add `configDir?: string` as last parameter, include in apiCall params.

`mcpGet`:
```typescript
  async mcpGet(name: string, configDir?: string): Promise<MCPServer> {
```
Include `configDir` in the apiCall params.

`mcpRemove`:
```typescript
  async mcpRemove(name: string, configDir?: string): Promise<string> {
```
Include `configDir` in the apiCall params.

`mcpAddJson` — add `configDir?: string` as last parameter, include in apiCall params.

`mcpAddFromClaudeDesktop` — add `configDir?: string` as last parameter, include in apiCall params.

`mcpGetServerStatus`:
```typescript
  async mcpGetServerStatus(configDir?: string): Promise<Record<string, any>> {
```

`mcpTestConnection`:
```typescript
  async mcpTestConnection(name: string, configDir?: string): Promise<string> {
```

- [ ] **Step 2: Update SlashCommands API methods**

`slashCommandsList`:
```typescript
  async slashCommandsList(projectPath?: string, configDir?: string): Promise<SlashCommand[]> {
    try {
      return await apiCall<SlashCommand[]>("slash_commands_list", { projectPath, configDir });
    } catch (error) {
      console.error("Failed to list slash commands:", error);
      throw error;
    }
  },
```

`slashCommandGet`:
```typescript
  async slashCommandGet(commandId: string, configDir?: string): Promise<SlashCommand> {
    try {
      return await apiCall<SlashCommand>("slash_command_get", { commandId, configDir });
```

`slashCommandSave` — add `configDir` to the params object passed to apiCall.

`slashCommandDelete` — add `configDir?: string` as last parameter.

- [ ] **Step 3: Run check and build**

Run: `npm run check && npm run build`

Expected: Pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: add configDir to MCP and SlashCommands renderer API"
```

---

## Task 5: Renderer components — pass configDir through

**Files:**
- Modify: `src/components/MCPManager.tsx`
- Modify: `src/components/MCPServerList.tsx`
- Modify: `src/components/MCPAddServer.tsx`
- Modify: `src/components/MCPImportExport.tsx`
- Modify: `src/components/SlashCommandsManager.tsx`
- Modify: `src/components/SlashCommandPicker.tsx`
- Modify: `src/components/TabContent.tsx`
- Modify: `src/components/ClaudeCodeSession.tsx`

- [ ] **Step 1: Add configDir prop to MCPManager and its children**

In `MCPManager.tsx`, add `configDir?: string` to `MCPManagerProps`. Pass it to `api.mcpList(configDir)` in `loadServers()`. Pass it as prop to `MCPServerList`, `MCPAddServer`, `MCPImportExport`.

In `MCPServerList.tsx`, add `configDir?: string` to its props. Pass to `api.mcpRemove(name, configDir)`.

In `MCPAddServer.tsx`, add `configDir?: string` to its props. Pass to `api.mcpAdd(..., configDir)`.

In `MCPImportExport.tsx`, add `configDir?: string` to its props. Pass to `api.mcpAddFromClaudeDesktop(scope, configDir)` and `api.mcpAddJson(name, json, scope, configDir)`.

- [ ] **Step 2: Add configDir prop to SlashCommandsManager and SlashCommandPicker**

In `SlashCommandsManager.tsx`, add `configDir?: string` to `SlashCommandsManagerProps`. Pass to `api.slashCommandsList(projectPath, configDir)`, `api.slashCommandSave({..., configDir})`, `api.slashCommandDelete(id, projectPath, configDir)`.

In `SlashCommandPicker.tsx`, add `configDir?: string` to its props. Pass to `api.slashCommandsList(projectPath, configDir)`.

- [ ] **Step 3: Pass configDir from TabContent to MCPManager**

In `TabContent.tsx`, where `<MCPManager>` is rendered (line ~381), resolve `configDir` from account context and pass it:

```tsx
<MCPManager onBack={() => {}} configDir={resolvedConfigDir} />
```

The `configDir` comes from the active account. TabContent can resolve it by:
1. Getting the active chat tab's `accountName`
2. Looking up the account's `config_dir` from `useAccounts()`

Or more simply: accept an optional `configDir` prop from the tab data, since chat tabs already have account resolution. For the MCP tab (which isn't project-scoped), use the default account or let the user pick.

For now, the simplest correct approach: if the MCP tab has no explicit account context, pass `undefined` (which uses the default). Account-scoped MCP management in Settings can be a follow-up.

- [ ] **Step 4: Pass configDir from ClaudeCodeSession to SlashCommandsManager**

In `ClaudeCodeSession.tsx`, where `<SlashCommandsManager>` is rendered (line ~2248):

```tsx
<SlashCommandsManager
  projectPath={projectPath}
  configDir={accountResolution?.account.config_dir}
/>
```

`accountResolution` is already available in ClaudeCodeSession state (line ~146).

Similarly, where `<SlashCommandPicker>` is used inside `<FloatingPromptInput>`, pass `configDir` through. FloatingPromptInput already receives `projectPath` — add `configDir` prop and pass it to `SlashCommandPicker`.

- [ ] **Step 5: Run check and build**

Run: `npm run check && npm run build`

Expected: Pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/MCPManager.tsx src/components/MCPServerList.tsx src/components/MCPAddServer.tsx src/components/MCPImportExport.tsx src/components/SlashCommandsManager.tsx src/components/SlashCommandPicker.tsx src/components/TabContent.tsx src/components/ClaudeCodeSession.tsx
git commit -m "feat: pass configDir through MCP and SlashCommands renderer components"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run full verification gate**

Run: `npm run check && npm run build && npm run test:coverage`

Expected: All pass. Coverage at or above 80%.

- [ ] **Step 2: Verify the app runs**

Run: `npm start`

Verify:
- MCP Manager shows servers (from default account if no account context)
- Slash Commands Manager lists commands
- In an active session with a non-default account, slash commands and MCP show that account's config
- No console errors about missing params or broken IPC

- [ ] **Step 3: Commit any fixes**

If any fixes were needed, commit them individually.
