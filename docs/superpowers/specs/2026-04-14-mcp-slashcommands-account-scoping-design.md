# MCP & SlashCommands Account Scoping Design

**Date**: 2026-04-14
**Approach**: Per-call configDir parameter on every service method

---

## Problem

Both `createMCPService(configDir)` and `createSlashCommandsService(configDir)` bake `~/.claude` in at construction time (`main.ts:223-224`). All MCP and slash command operations read/write to the default account's settings regardless of which account is active.

For multi-account users (e.g., `~/.claude` personal + `~/.claude-enterprise` work), this means:
- MCP servers configured under the enterprise account are invisible
- Adding/removing MCP servers always writes to the default account
- Slash commands from the enterprise account's `commands/` directory are never listed
- There's no way to manage per-account MCP or slash command configuration

---

## Solution

Change both services to accept `configDir` as an optional parameter on every method. When provided, it overrides the default. When omitted, the default `~/.claude` is used for backwards compatibility.

This matches the pattern already used by `ClaudeService`, which takes account context per-call rather than at construction.

---

## MCP Service Changes

### Interface

```typescript
export interface MCPService {
  add(params: any & { configDir?: string }): any;
  list(configDir?: string): any[];
  get(name: string, configDir?: string): any;
  remove(name: string, configDir?: string): string;
  addJson(params: any & { configDir?: string }): any;
  addFromClaudeDesktop(scope?: string, configDir?: string): any;
  serve(): string;
  testConnection(name: string, configDir?: string): string;
  resetProjectChoices(): string;
  getServerStatus(configDir?: string): Record<string, any>;
  readProjectConfig(projectPath: string): any;      // no configDir needed
  saveProjectConfig(projectPath: string, config: any): string;  // no configDir needed
}
```

### Implementation

The `settingsPath` closure constant is replaced with a per-call computation:

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
    const settingsPath = getSettingsPath(configDir);
    const settings = readSettings(settingsPath);
    settings.mcpServers = servers;
    writeSettings(settingsPath, settings);
  }

  // Every method passes configDir through to getMcpServers/saveMcpServers
}
```

`readProjectConfig` and `saveProjectConfig` operate on `projectPath/.mcp.json`, not account settings, so they don't need `configDir`.

---

## SlashCommands Service Changes

### Interface

```typescript
export interface SlashCommandsService {
  list(projectPath?: string, configDir?: string): SlashCommand[];
  get(commandId: string, configDir?: string): SlashCommand;
  save(params: SaveParams): SlashCommand;  // configDir inside SaveParams
  delete(commandId: string, projectPath?: string, configDir?: string): string;
}

export interface SaveParams {
  scope: string;
  name: string;
  namespace: string;
  content: string;
  description: string;
  allowedTools: string;
  projectPath?: string;
  configDir?: string;  // NEW
}
```

### Implementation

The `globalCommandsDir` closure constant is replaced with a per-call computation:

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

  // get(), save(), delete() all use getCommandsDir(configDir) instead of globalCommandsDir
}
```

---

## IPC Handler Changes

Each MCP and SlashCommands handler extracts `configDir` (accepting both camelCase and snake_case):

```typescript
// MCP handlers
mcp_list: wrapWith((p) => mcp?.list((p?.configDir ?? p?.config_dir) as string | undefined) ?? null),
mcp_add: wrapWith((p) => mcp?.add(p) ?? null),  // configDir is inside params object
mcp_get: wrapWith((p) => mcp?.get(p?.name as string, (p?.configDir ?? p?.config_dir) as string | undefined) ?? null),
mcp_remove: wrapWith((p) => mcp?.remove(p?.name as string, (p?.configDir ?? p?.config_dir) as string | undefined) ?? null),
// etc.

// SlashCommands handlers
slash_commands_list: wrapWith((p) => slashCommands?.list(
  (p?.projectPath ?? p?.project_path) as string | undefined,
  (p?.configDir ?? p?.config_dir) as string | undefined,
) ?? null),
slash_command_get: wrapWith((p) => slashCommands?.get(
  (p?.commandId ?? p?.command_id) as string,
  (p?.configDir ?? p?.config_dir) as string | undefined,
) ?? null),
// etc.
```

---

## Renderer API Changes

Each `api.ts` method adds optional `configDir?` parameter:

```typescript
async mcpList(configDir?: string): Promise<MCPServer[]> {
  return apiCall("mcp_list", { configDir });
}

async mcpAdd(name, transport, command?, args?, env?, url?, scope?, configDir?): Promise<AddServerResult> {
  return apiCall("mcp_add", { name, transport, command, args, env, url, scope, configDir });
}

async slashCommandsList(projectPath?: string, configDir?: string): Promise<SlashCommand[]> {
  return apiCall("slash_commands_list", { projectPath, configDir });
}
// etc.
```

---

## Renderer Component Updates

Components that call MCP or SlashCommands APIs need to resolve and pass `configDir`.

### MCPManager

Gets `configDir` from account resolution. The MCPManager component currently lives in the Settings panel and as a session side panel. It needs either:
- A `configDir` prop from its parent, or
- To resolve it from the active project/account context

Since MCPManager in Settings doesn't have a project context, it should accept a `configDir` prop. The Settings panel knows the active account from `AccountsContext`.

### SlashCommandsManager / SlashCommandPicker

Already receives `projectPath`. For `configDir`, same pattern: accept as prop, resolved from account context by parent.

### ClaudeCodeSession (MCP panel, slash command picker)

Already has `accountResolution?.account.config_dir`. Pass it through to child components.

---

## Testing

### Existing test updates
- Update `electron/__tests__/mcp.test.ts` to pass `configDir` per-call
- Update `electron/__tests__/slash-commands.test.ts` to pass `configDir` per-call

### New tests
- **MCP**: Create two temp directories simulating two accounts. Verify `list(configDirA)` returns different results from `list(configDirB)`. Verify `add({..., configDir: dirA})` only writes to dirA.
- **SlashCommands**: Same pattern. Verify `list(undefined, configDirA)` returns commands from dirA, not dirB.
- **Backwards compat**: Verify omitting `configDir` uses the default.

---

## Out of Scope

- MCP process management (serve, testConnection, getServerStatus stubs) — separate feature
- Typing MCP service return values — separate cleanup
- Per-account UI selector in Settings — would be nice but not required; the account context flows from the active project
