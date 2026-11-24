/**
 * How the Brain MCP server reaches a Claude session.
 *
 * Two paths, both here:
 *
 *  - **Spawn time (default).** OmniFex writes a config under userData and adds
 *    `--mcp-config` to the sessions it launches. Nothing is written into the
 *    user's Claude config, and turning it off is deleting an argument.
 *  - **Persistent (opt-in, per account).** The same server block is written
 *    into `<configDir>/.claude.json` so sessions started outside OmniFex get
 *    it too. This is the only path that leaves residue, which is why it is
 *    off by default and removable from the same toggle.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { MCPServerConfig, MCPService } from '../mcp';

export const BRAIN_MCP_SERVER_NAME = 'omnifex-brain';

/**
 * Pre-allowed on both paths.
 *
 * Retrieval is read-only against the user's own vault, and a permission prompt
 * on the first search of every session is exactly the friction that stops a
 * model using a memory tool at all. `brain_remember` is deliberately absent: a
 * write stays a deliberate, visible act.
 *
 * The `mcp__<server>__<tool>` form is the documented rule syntax for a single
 * MCP tool; MCP rules take no argument parentheses.
 */
export const BRAIN_MCP_READ_TOOLS = [
  `mcp__${BRAIN_MCP_SERVER_NAME}__brain_search`,
  `mcp__${BRAIN_MCP_SERVER_NAME}__brain_read`,
] as const;

export interface BrainMcpEnvironment {
  /** The node the server runs on: the app's `omnifexd`, or a checkout's node. */
  execPath: string;
  /** Absolute path to the built `brain-mcp.js`. */
  serverScript: string;
  /** `~/Library/Application Support/OmniFex`, where greychrist.db lives. */
  userDataDir: string;
}

/** Where the installed OmniFex keeps the two files the server needs. */
export const INSTALLED_APP_PATH = '/Applications/OmniFex.app';

export type InstalledApp = Pick<BrainMcpEnvironment, 'execPath' | 'serverScript'>;

/** Inside an app bundle, the server script sits here (see the package script). */
const BUNDLED_SCRIPT = ['Contents', 'Resources', 'app', 'build', 'brain-mcp.js'];

/**
 * The installed app's node and `brain-mcp.js`, or null when it is not there.
 */
export function findInstalledApp(
  appPath: string = INSTALLED_APP_PATH,
  exists: (path: string) => boolean = existsSync,
): InstalledApp | null {
  const execPath = join(appPath, 'Contents', 'MacOS', 'omnifexd');
  const serverScript = join(appPath, ...BUNDLED_SCRIPT);
  if (!exists(execPath) || !exists(serverScript)) return null;
  return { execPath, serverScript };
}

/**
 * What the PERSISTENT registration may name.
 *
 * `<configDir>/.claude.json` outlives the process that wrote it, and every
 * Claude session started anywhere spawns whatever it names. A dev build used
 * to name its checkout there, so every session kept the checkout's
 * `better_sqlite3.node` loaded — and `npm test`'s pretest rebuild overwrote
 * that file in place underneath them, which macOS answers with SIGKILL (Code
 * Signature Invalid): ~4 crash reports a day, and a Brain server killed
 * mid-session. A packaged app (its script at `Contents/Resources/app/build`
 * inside an `.app`) is named as it is; anything else is swapped for the
 * installed app, or refused (null) when there is none. "Anything else"
 * includes a registration naming the pre-2026-10-23 Electron bundle, whose
 * script lived inside `app.asar` — re-registering names the new layout. The
 * spawn-time config is not affected: it is rewritten per session by the
 * instance that launches it.
 */
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
      // The server has no account concept. This one path IS the isolation.
      OMNIFEX_VAULT: vaultRoot,
      OMNIFEX_BRAIN_DB: join(vaultRoot, '.omnifex', 'index.db'),
    },
  };
}

/**
 * Write the `--mcp-config` file for one account and return its path.
 *
 * Under userData rather than inside the vault: it holds machine-specific
 * absolute paths including `execPath`, and a vault is a directory the user may
 * sync, open in Obsidian, or copy to another machine. It is derived state,
 * rewritten whenever the vault or the app moves.
 */
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

/**
 * The CLI arguments that hand a session the Brain.
 *
 * Never `--strict-mcp-config`: it would suppress every other MCP server the
 * user has configured, which is a hostile side effect of enabling a memory
 * tool. `--mcp-config` and `--allowedTools` both MERGE with what the account
 * already has (measured against CLI 2.1.228).
 */
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
  /**
   * Add or remove ONLY the Brain's own rules. The user's list is read,
   * filtered of exactly these two entries, and written back — so a rule
   * someone added by hand survives both register and unregister.
   */
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
        // An unreadable config dir means "not registered" — this answers a
        // toggle's state, and throwing would break the Brain tab over a
        // question that has a safe answer.
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
        // Absent is the desired end state, so removing what is not there is a
        // success, not an error.
      }
      setAllowRules(configDir, false);
    },
  };
}

/**
 * Re-write every persistent registration that exists, so it names this
 * build's server. Run once at daemon start.
 *
 * `.claude.json` keeps whatever path wrote it, and an update that moves the
 * server leaves every registered account pointing at a file that is gone —
 * the Electron → Swift update moved both the executable (`omnifex` →
 * `omnifexd`) and the script (out of `app.asar`). Accounts that never opted
 * in are untouched: registering is the user's choice, not this function's.
 * One account failing (no installed app to name, an unwritable config) costs
 * that account's refresh, never the others' or the daemon's start.
 */
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
