import fs from 'node:fs';
import path from 'node:path';

export interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: string;
  [key: string]: unknown;
}

export interface MCPServer extends MCPServerConfig {
  name: string;
}

export interface MCPAddParams {
  name?: string;
  configDir?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: string;
  [key: string]: unknown;
}

export interface MCPAddJsonParams {
  name: string;
  json: string | Record<string, unknown>;
  configDir?: string;
}

export interface MCPImportResult {
  imported: number;
  scope: string;
  message: string;
}

export interface MCPServerStatus {
  status: 'unknown' | 'running' | 'stopped' | 'error';
  pid: number | null;
}

export interface MCPProjectConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

/** @deprecated Use MCPServer instead */
export type MCPServerEntry = MCPServer;

export interface MCPService {
  add(params: MCPAddParams): MCPServer;
  list(configDir?: string): MCPServer[];
  get(name: string, configDir?: string): MCPServer;
  remove(name: string, configDir?: string): string;
  addJson(params: MCPAddJsonParams): MCPServer;
  addFromClaudeDesktop(scope?: string, configDir?: string): MCPImportResult;
  serve(): string;
  testConnection(name: string, configDir?: string): string;
  resetProjectChoices(): string;
  getServerStatus(configDir?: string): Record<string, MCPServerStatus>;
  readProjectConfig(projectPath: string): MCPProjectConfig;
  saveProjectConfig(projectPath: string, config: MCPProjectConfig): string;
}

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Read-modify-write, never replace: `.claude.json` also holds the OAuth session, and dropping it signs the account out. */
function writeJsonFile(filePath: string, contents: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(contents, null, 2), 'utf-8');
}

export function createMCPService(): MCPService {
  /** User-scope servers live in `<configDir>/.claude.json`: the CLI never reads `mcpServers` from settings.json. No `~/.claude` fallback. */
  function getUserConfigPath(configDir?: string): string {
    if (!configDir) {
      throw new Error(
        'MCP: configDir is required. The renderer must pass the resolved ' +
        "account's config_dir; there is no default-account fallback.",
      );
    }
    return path.join(configDir, '.claude.json');
  }

  function getMcpServers(configDir?: string): Record<string, MCPServerConfig> {
    const config = readJsonFile(getUserConfigPath(configDir));
    return (config.mcpServers as Record<string, MCPServerConfig>) ?? {};
  }

  function saveMcpServers(servers: Record<string, MCPServerConfig>, configDir?: string): void {
    const configPath = getUserConfigPath(configDir);
    const config = readJsonFile(configPath);
    config.mcpServers = servers;
    writeJsonFile(configPath, config);
  }

  function list(configDir?: string): MCPServer[] {
    const servers = getMcpServers(configDir);
    return Object.entries(servers).map(([name, config]) => ({
      ...config,
      name,
    }));
  }

  function get(name: string, configDir?: string): MCPServer {
    const servers = getMcpServers(configDir);
    const config = servers[name];
    if (!config) {
      throw new Error(`MCP server not found: ${name}`);
    }
    return { ...config, name };
  }

  function add(params: MCPAddParams): MCPServer {
    const { name, configDir: cd, ...config } = params;
    if (!name) {
      throw new Error('MCP server name is required');
    }
    const servers = getMcpServers(cd);
    servers[name] = config;
    saveMcpServers(servers, cd);
    return { name, ...config };
  }

  function remove(name: string, configDir?: string): string {
    const servers = getMcpServers(configDir);
    if (!(name in servers)) {
      throw new Error(`MCP server not found: ${name}`);
    }
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- intentional removal of one property from a copied object; rest-spread alternative is more allocation-heavy.
    delete servers[name];
    saveMcpServers(servers, configDir);
    return `Removed MCP server: ${name}`;
  }

  function addJson(params: MCPAddJsonParams): MCPServer {
    const { name, json, configDir: cd } = params;
    let config: Record<string, unknown>;
    try {
      config = typeof json === 'string' ? (JSON.parse(json) as Record<string, unknown>) : json;
    } catch {
      throw new Error('Invalid JSON configuration');
    }
    return add({ name, ...config, configDir: cd });
  }

  function addFromClaudeDesktop(scope?: string, _configDir?: string): MCPImportResult {
    return { imported: 0, scope: scope ?? 'global', message: 'Claude Desktop import not yet implemented' };
  }

  function serve(): string {
    return 'MCP serve not yet implemented';
  }

  function testConnection(name: string, configDir?: string): string {
    try {
      get(name, configDir);
      return `Connection test for "${name}": stub response (not yet implemented)`;
    } catch (e: unknown) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function resetProjectChoices(): string {
    return 'Project choices reset (not yet implemented)';
  }

  function getServerStatus(configDir?: string): Record<string, MCPServerStatus> {
    const servers = getMcpServers(configDir);
    const status: Record<string, MCPServerStatus> = {};
    for (const name of Object.keys(servers)) {
      status[name] = { status: 'unknown', pid: null };
    }
    return status;
  }

  function readProjectConfig(projectPath: string): MCPProjectConfig {
    const configPath = path.join(projectPath, '.mcp.json');
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content) as MCPProjectConfig;
    } catch {
      return { mcpServers: {} };
    }
  }

  function saveProjectConfig(projectPath: string, config: MCPProjectConfig): string {
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
