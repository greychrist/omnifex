import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMCPService } from '../services/mcp';
import {
  BRAIN_MCP_READ_TOOLS,
  BRAIN_MCP_SERVER_NAME,
  brainSpawnArgs,
  buildBrainServerConfig,
  createBrainMcpRegistration,
  findInstalledApp,
  persistentServerEnv,
  writeBrainSpawnConfig,
} from '../services/brain/mcp-registration';

const EXEC = '/Applications/OmniFex.app/Contents/MacOS/omnifex';
const SCRIPT = '/Applications/OmniFex.app/Contents/Resources/app.asar/.vite/build/brain-mcp.js';

const env = (userDataDir: string) => ({ execPath: EXEC, serverScript: SCRIPT, userDataDir });

describe('brain MCP registration', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-reg-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('buildBrainServerConfig', () => {
    it('runs Electron as node against exactly one vault', () => {
      expect(buildBrainServerConfig('/vaults/personal', env(tmp))).toEqual({
        command: EXEC,
        args: [SCRIPT],
        env: {
          // Not system node: better-sqlite3 is built for the Electron ABI.
          ELECTRON_RUN_AS_NODE: '1',
          OMNIFEX_VAULT: '/vaults/personal',
          OMNIFEX_BRAIN_DB: join('/vaults/personal', '.omnifex', 'index.db'),
        },
      });
    });

    it('names no vault but the one it was given', () => {
      const config = buildBrainServerConfig('/vaults/personal', env(tmp));
      expect(JSON.stringify(config)).not.toContain('work');
    });
  });

  describe('writeBrainSpawnConfig', () => {
    it('writes under userData, never into the vault', () => {
      const vault = join(tmp, 'vault');
      mkdirSync(vault, { recursive: true });

      const path = writeBrainSpawnConfig(7, vault, env(tmp));

      // The file holds machine-specific absolute paths including execPath, and
      // a vault is a directory the user may sync or open in Obsidian.
      expect(path.startsWith(join(tmp, 'brain-mcp'))).toBe(true);
      expect(path).not.toContain(vault);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        mcpServers: { [BRAIN_MCP_SERVER_NAME]: buildBrainServerConfig(vault, env(tmp)) },
      });
    });

    it('keys the file by account so two accounts never share one', () => {
      const a = writeBrainSpawnConfig(1, join(tmp, 'one'), env(tmp));
      const b = writeBrainSpawnConfig(2, join(tmp, 'two'), env(tmp));
      expect(a).not.toBe(b);

      const first = JSON.parse(readFileSync(a, 'utf8')) as {
        mcpServers: Record<string, { env: Record<string, string> }>;
      };
      expect(first.mcpServers[BRAIN_MCP_SERVER_NAME].env.OMNIFEX_VAULT).toBe(join(tmp, 'one'));
    });

    it('rewrites in place when the vault moves', () => {
      const first = writeBrainSpawnConfig(7, join(tmp, 'one'), env(tmp));
      const second = writeBrainSpawnConfig(7, join(tmp, 'two'), env(tmp));
      expect(second).toBe(first);

      const written = JSON.parse(readFileSync(first, 'utf8')) as {
        mcpServers: Record<string, { env: Record<string, string> }>;
      };
      expect(written.mcpServers[BRAIN_MCP_SERVER_NAME].env.OMNIFEX_VAULT).toBe(join(tmp, 'two'));
    });
  });

  describe('brainSpawnArgs', () => {
    it('merges with the session rather than replacing its MCP config', () => {
      const args = brainSpawnArgs('/data/brain-mcp/7.json');
      expect(args).toEqual([
        '--mcp-config',
        '/data/brain-mcp/7.json',
        '--allowedTools',
        'mcp__omnifex-brain__brain_search,mcp__omnifex-brain__brain_read',
      ]);
      // --strict-mcp-config would suppress every other server the user has.
      expect(args).not.toContain('--strict-mcp-config');
    });

    it('never pre-allows the write tool', () => {
      // A write stays a deliberate, visible act even though it only appends to
      // a capture file in the user's own vault.
      expect(brainSpawnArgs('/x.json').join(' ')).not.toContain('brain_remember');
    });
  });

  describe('createBrainMcpRegistration', () => {
    const registration = (userData: string) =>
      createBrainMcpRegistration(createMCPService(), env(userData));

    it('registers into .claude.json and allows the read tools', () => {
      const configDir = join(tmp, 'cfg');
      const reg = registration(tmp);
      expect(reg.isRegistered(configDir)).toBe(false);

      reg.register(configDir, '/vaults/personal');

      expect(reg.isRegistered(configDir)).toBe(true);
      const claudeJson = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')) as {
        mcpServers: Record<string, { env: Record<string, string> }>;
      };
      expect(claudeJson.mcpServers[BRAIN_MCP_SERVER_NAME].env.OMNIFEX_VAULT).toBe('/vaults/personal');

      const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
        permissions: { allow: string[] };
      };
      expect(settings.permissions.allow).toEqual([...BRAIN_MCP_READ_TOOLS]);
    });

    it('unregisters both the server and the rules it added', () => {
      const configDir = join(tmp, 'cfg');
      const reg = registration(tmp);
      reg.register(configDir, '/vaults/personal');

      reg.unregister(configDir);

      expect(reg.isRegistered(configDir)).toBe(false);
      const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
        permissions: { allow: string[] };
      };
      expect(settings.permissions.allow).toEqual([]);
    });

    it("leaves the user's own permission rules alone", () => {
      const configDir = join(tmp, 'cfg2');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'settings.json'),
        JSON.stringify({ permissions: { allow: ['Bash(git status)'], deny: ['Read(./secrets/**)'] } }),
        'utf8',
      );
      const reg = registration(tmp);

      reg.register(configDir, '/v');
      reg.unregister(configDir);

      const after = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
        permissions: { allow: string[]; deny: string[] };
      };
      // Only ever adds and removes its own two rules.
      expect(after.permissions.allow).toEqual(['Bash(git status)']);
      expect(after.permissions.deny).toEqual(['Read(./secrets/**)']);
    });

    it('preserves unrelated settings keys', () => {
      const configDir = join(tmp, 'cfg3');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }), 'utf8');
      registration(tmp).register(configDir, '/v');

      const after = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
        model: string;
      };
      expect(after.model).toBe('claude-opus-5');
    });

    it('is idempotent — registering twice adds one server and one rule pair', () => {
      const configDir = join(tmp, 'cfg4');
      const reg = registration(tmp);
      reg.register(configDir, '/v');
      reg.register(configDir, '/v');

      const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
        permissions: { allow: string[] };
      };
      expect(settings.permissions.allow).toEqual([...BRAIN_MCP_READ_TOOLS]);
      expect(createMCPService().list(configDir)).toHaveLength(1);
    });

    it('unregistering something never registered is not an error', () => {
      const configDir = join(tmp, 'cfg5');
      expect(() => { registration(tmp).unregister(configDir); }).not.toThrow();
    });

    it('never touches another account\'s config dir', () => {
      const a = join(tmp, 'a');
      const b = join(tmp, 'b');
      mkdirSync(b, { recursive: true });
      registration(tmp).register(a, '/vaults/personal');
      expect(() => readFileSync(join(b, '.claude.json'), 'utf8')).toThrow();
    });
  });
});

/**
 * The persistent registration outlives the process that wrote it: every
 * Claude session started anywhere spawns whatever it names. Naming a dev
 * checkout kept that checkout's better_sqlite3.node loaded in every session,
 * and `npm test`'s pretest rebuild then overwrote it in place under them —
 * which macOS answers with SIGKILL (Code Signature Invalid). So it always
 * names an installed app, never a checkout.
 */
describe('persistent registration targets the installed app', () => {
  const CHECKOUT = {
    execPath: '/Users/me/Repos/omnifex/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    serverScript: '/Users/me/Repos/omnifex/.vite/build/brain-mcp.js',
    userDataDir: '/ud',
  };
  const INSTALLED = { execPath: EXEC, serverScript: SCRIPT };

  it('keeps a packaged app as it is', () => {
    const packaged = { ...INSTALLED, userDataDir: '/ud' };
    expect(persistentServerEnv(packaged, () => null)).toEqual(packaged);
  });

  it('swaps a checkout for the installed app', () => {
    expect(persistentServerEnv(CHECKOUT, () => INSTALLED)).toEqual({ ...INSTALLED, userDataDir: '/ud' });
  });

  it('refuses a checkout when no app is installed', () => {
    expect(persistentServerEnv(CHECKOUT, () => null)).toBeNull();
  });

  it('finds the app by its real files, not by paths inside the asar', () => {
    const app = '/Applications/OmniFex.app';
    const present = new Set([`${app}/Contents/MacOS/omnifex`, `${app}/Contents/Resources/app.asar`]);
    expect(findInstalledApp(app, (p) => present.has(p))).toEqual(INSTALLED);
    expect(findInstalledApp(app, () => false)).toBeNull();
  });

  describe('createBrainMcpRegistration from a dev build', () => {
    let tmp: string;
    beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'brain-reg-dev-')); });
    afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

    it('writes the installed app into .claude.json, never the checkout', () => {
      const configDir = join(tmp, 'cfg');
      createBrainMcpRegistration(createMCPService(), { ...CHECKOUT, userDataDir: tmp }, () => INSTALLED)
        .register(configDir, '/vaults/personal');

      const raw = readFileSync(join(configDir, '.claude.json'), 'utf8');
      const entry = (JSON.parse(raw) as { mcpServers: Record<string, { command: string; args: string[] }> })
        .mcpServers[BRAIN_MCP_SERVER_NAME];
      expect(entry.command).toBe(EXEC);
      expect(entry.args).toEqual([SCRIPT]);
      expect(raw).not.toContain('/Repos/');
    });

    it('refuses to register when there is no installed app to name', () => {
      const configDir = join(tmp, 'cfg');
      const reg = createBrainMcpRegistration(createMCPService(), { ...CHECKOUT, userDataDir: tmp }, () => null);
      expect(() => { reg.register(configDir, '/vaults/personal'); }).toThrow(/installed/i);
      expect(reg.isRegistered(configDir)).toBe(false);
    });
  });
});
