import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface MCPServerEntry {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSettings(settingsPath: string): Record<string, any> {
  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function writeSettings(settingsPath: string, settings: Record<string, any>): void {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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

  function list(configDir?: string): any[] {
    const servers = getMcpServers(configDir);
    return Object.entries(servers).map(([name, config]) => ({
      ...config,
      name,
    }));
  }

  function get(name: string, configDir?: string): any {
    const servers = getMcpServers(configDir);
    const config = servers[name];
    if (!config) {
      throw new Error(`MCP server not found: ${name}`);
    }
    return { ...config, name };
  }

  function add(params: any): any {
    const { name, configDir: cd, ...config } = params;
    if (!name) {
      throw new Error('MCP server name is required');
    }
    const servers = getMcpServers(cd);
    servers[name] = config as MCPServerEntry;
    saveMcpServers(servers, cd);
    return { name, ...config };
  }

  function remove(name: string, configDir?: string): string {
    const servers = getMcpServers(configDir);
    if (!(name in servers)) {
      throw new Error(`MCP server not found: ${name}`);
    }
    delete servers[name];
    saveMcpServers(servers, configDir);
    return `Removed MCP server: ${name}`;
  }

  function addJson(params: any): any {
    // Parse JSON string config and add
    const { name, json, configDir: cd } = params;
    let config: any;
    try {
      config = typeof json === 'string' ? JSON.parse(json) : json;
    } catch {
      throw new Error('Invalid JSON configuration');
    }
    return add({ name, ...config, configDir: cd });
  }

  function addFromClaudeDesktop(scope?: string, _configDir?: string): any {
    // Stub: reads Claude Desktop config and imports MCP servers
    return { imported: 0, scope: scope ?? 'global', message: 'Claude Desktop import not yet implemented' };
  }

  function serve(): string {
    // Stub: MCP process management is a later feature
    return 'MCP serve not yet implemented';
  }

  function testConnection(name: string, configDir?: string): string {
    // Stub: testing live connections requires running processes
    try {
      get(name, configDir); // Validate server exists
      return `Connection test for "${name}": stub response (not yet implemented)`;
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  function resetProjectChoices(): string {
    // Stub: resets user's per-project MCP choices
    return 'Project choices reset (not yet implemented)';
  }

  function getServerStatus(configDir?: string): Record<string, any> {
    // Stub: returns status of running MCP processes
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
    add,
    list,
    get,
    remove,
    addJson,
    addFromClaudeDesktop,
    serve,
    testConnection,
    resetProjectChoices,
    getServerStatus,
    readProjectConfig,
    saveProjectConfig,
  };
}
