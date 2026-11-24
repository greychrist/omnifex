import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { MCPServerConfig, MCPService } from '../mcp';

export const BRAIN_MCP_SERVER_NAME = 'omnifex-brain';

/** `brain_remember` is deliberately absent: a write stays a visible act. MCP rules take no parentheses. */
export const BRAIN_MCP_READ_TOOLS = [
  `mcp__${BRAIN_MCP_SERVER_NAME}__brain_search`,
  `mcp__${BRAIN_MCP_SERVER_NAME}__brain_read`,
] as const;

export interface BrainMcpEnvironment {
  /** Never PATH node: better-sqlite3 is built for one Node major. */
  execPath: string;
  serverScript: string;
  userDataDir: string;
}

export const INSTALLED_APP_PATH = '/Applications/OmniFex.app';

export type InstalledApp = Pick<BrainMcpEnvironment, 'execPath' | 'serverScript'>;

/** Must match the bundle layout packaging writes. */
const BUNDLED_SCRIPT = ['Contents', 'Resources', 'app', 'build', 'brain-mcp.js'];

export function findInstalledApp(
  appPath: string = INSTALLED_APP_PATH,
  exists: (path: string) => boolean = existsSync,
): InstalledApp | null {
  const execPath = join(appPath, 'Contents', 'MacOS', 'omnifexd');
  const serverScript = join(appPath, ...BUNDLED_SCRIPT);
  if (!exists(execPath) || !exists(serverScript)) return null;
  return { execPath, serverScript };
}

/** Never name a dev checkout: sessions load its better_sqlite3.node, and an in-place rebuild gets them SIGKILLed. */
export function persistentServerEnv(
  env: BrainMcpEnvironment,
  findInstalled: () => InstalledApp | null = findInstalledApp,
): BrainMcpEnvironment | null {
  if (env.serverScript.includes(`.app${sep}${BUNDLED_SCRIPT.join(sep)}`)) return env;
  const installed = findInstalled();
  return installed ? { ...env, ...installed } : null;
}

export function buildBrainServerConfig(
  vaultRoot: string,
  env: BrainMcpEnvironment,
): MCPServerConfig {
  return {
    command: env.execPath,
    args: [env.serverScript],
    env: {
      // The server has no account concept: this one path IS the isolation.
      OMNIFEX_VAULT: vaultRoot,
      OMNIFEX_BRAIN_DB: join(vaultRoot, '.omnifex', 'index.db'),
    },
  };
}

/** Under userData, never the vault: it holds machine-specific absolute paths. */
export function writeBrainSpawnConfig(
  accountId: number,
  vaultRoot: string,
  env: BrainMcpEnvironment,
): string {
  const dir = join(env.userDataDir, 'brain-mcp');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${String(accountId)}.json`);
  const contents = {
    mcpServers: { [BRAIN_MCP_SERVER_NAME]: buildBrainServerConfig(vaultRoot, env) },
  };
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
  return path;
}

/** Never `--strict-mcp-config`: it would suppress the user's other MCP servers. */
export function brainSpawnArgs(configPath: string): string[] {
  return ['--mcp-config', configPath, '--allowedTools', BRAIN_MCP_READ_TOOLS.join(',')];
}

export interface BrainMcpRegistration {
  isRegistered(configDir: string): boolean;
  register(configDir: string, vaultRoot: string): void;
  unregister(configDir: string): void;
}

interface Settings extends Record<string, unknown> {
  permissions?: Record<string, unknown> & { allow?: string[] };
}

function readSettings(path: string): Settings {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Settings;
  } catch {
    return {};
  }
}

export function createBrainMcpRegistration(
  mcp: MCPService,
  env: BrainMcpEnvironment,
  findInstalled: () => InstalledApp | null = findInstalledApp,
): BrainMcpRegistration {
  /** Touch only the Brain's own rules, so hand-added rules survive. */
  function setAllowRules(configDir: string, present: boolean): void {
    const path = join(configDir, 'settings.json');
    const settings = readSettings(path);
    const permissions = { ...(settings.permissions ?? {}) };
    const current = Array.isArray(permissions.allow) ? permissions.allow : [];
    const without = current.filter((rule) => !BRAIN_MCP_READ_TOOLS.some((r) => r === rule));
    permissions.allow = present ? [...without, ...BRAIN_MCP_READ_TOOLS] : without;

    mkdirSync(configDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...settings, permissions }, null, 2)}\n`, 'utf8');
  }

  return {
    isRegistered(configDir) {
      try {
        return mcp.list(configDir).some((s) => s.name === BRAIN_MCP_SERVER_NAME);
      } catch {
        // Unreadable means "not registered": never break the Brain tab over it.
        return false;
      }
    },

    register(configDir, vaultRoot) {
      const target = persistentServerEnv(env, findInstalled);
      if (!target) {
        throw new Error(
          `OmniFex is not installed at ${INSTALLED_APP_PATH}; a development build will not `
          + 'register its own checkout, because every Claude session would then load it.',
        );
      }
      mcp.add({
        name: BRAIN_MCP_SERVER_NAME,
        configDir,
        ...buildBrainServerConfig(vaultRoot, target),
      });
      setAllowRules(configDir, true);
    },

    unregister(configDir) {
      try {
        mcp.remove(BRAIN_MCP_SERVER_NAME, configDir);
      } catch {
        // Already absent is success.
      }
      setAllowRules(configDir, false);
    },
  };
}

/** One account failing must never cost the others or the daemon's start. Accounts that never opted in are untouched. */
export function refreshBrainRegistrations(
  registration: BrainMcpRegistration,
  targets: { configDir: string; vaultRoot: string | null }[],
  warn: (message: string) => void,
): number {
  let refreshed = 0;
  for (const { configDir, vaultRoot } of targets) {
    if (!vaultRoot || !registration.isRegistered(configDir)) continue;
    try {
      registration.register(configDir, vaultRoot);
      refreshed++;
    } catch (err) {
      warn(`brain MCP registration for ${configDir} not refreshed: ${String(err)}`);
    }
  }
  return refreshed;
}
