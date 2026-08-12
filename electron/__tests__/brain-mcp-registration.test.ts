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
