import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMCPService, type MCPService } from '../services/mcp';

describe('mcp service', () => {
  let tmpDir: string;
  let configDir: string;
  let mcp: MCPService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greychrist-mcp-test-'));
    configDir = tmpDir;

    // Create the settings.json with an empty mcpServers object
    const settingsPath = path.join(configDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: {} }), 'utf-8');

    mcp = createMCPService(configDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('list returns empty array when no servers configured', () => {
    const servers = mcp.list();
    expect(Array.isArray(servers)).toBe(true);
    expect(servers).toHaveLength(0);
  });

  it('add registers a server and list returns it', () => {
    mcp.add({
      name: 'my-server',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    });

    const servers = mcp.list();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('my-server');
  });

  it('get retrieves a specific server by name', () => {
    mcp.add({
      name: 'test-server',
      command: 'node',
      args: ['server.js'],
    });

    const server = mcp.get('test-server');
    expect(server).not.toBeNull();
    expect(server.name).toBe('test-server');
    expect(server.command).toBe('node');
  });

  it('remove deletes a server', () => {
    mcp.add({ name: 'to-delete', command: 'cmd', args: [] });
    expect(mcp.list()).toHaveLength(1);

    const result = mcp.remove('to-delete');
    expect(result).toContain('to-delete');
    expect(mcp.list()).toHaveLength(0);
  });

  it('readProjectConfig and saveProjectConfig round-trip', () => {
    const projectPath = path.join(tmpDir, 'my-project');
    fs.mkdirSync(projectPath, { recursive: true });

    const config = {
      mcpServers: {
        'project-server': {
          command: 'python3',
          args: ['server.py'],
        },
      },
    };

    mcp.saveProjectConfig(projectPath, config);
    const loaded = mcp.readProjectConfig(projectPath);
    expect(loaded.mcpServers['project-server']).toBeDefined();
    expect(loaded.mcpServers['project-server'].command).toBe('python3');
  });

  it('add persists across service re-instantiation', () => {
    mcp.add({ name: 'persistent', command: 'node', args: ['x.js'] });

    // Re-create the service with the same configDir
    const mcp2 = createMCPService(configDir);
    const servers = mcp2.list();
    expect(servers.some((s: any) => s.name === 'persistent')).toBe(true);
  });

  it('getServerStatus returns stub data', () => {
    const status = mcp.getServerStatus();
    expect(typeof status).toBe('object');
  });

  it('testConnection returns a stub string', () => {
    mcp.add({ name: 'conn-test', command: 'node', args: [] });
    const result = mcp.testConnection('conn-test');
    expect(typeof result).toBe('string');
  });

  // ---- coverage-driven additions ----

  it('add throws when name is missing', () => {
    expect(() => mcp.add({ command: 'node' })).toThrow(/name is required/);
  });

  it('get throws when the server does not exist', () => {
    expect(() => mcp.get('nonexistent')).toThrow(/not found/);
  });

  it('remove throws when the server does not exist', () => {
    expect(() => mcp.remove('ghost')).toThrow(/not found/);
  });

  it('addJson parses a JSON string and registers the server', () => {
    const result = mcp.addJson({
      name: 'from-json',
      json: JSON.stringify({ command: 'deno', args: ['run', 'main.ts'] }),
    });
    expect(result.name).toBe('from-json');
    expect(mcp.get('from-json').command).toBe('deno');
  });

  it('addJson accepts an already-parsed object', () => {
    mcp.addJson({
      name: 'from-obj',
      json: { command: 'bun', args: ['server.ts'] },
    });
    expect(mcp.get('from-obj').command).toBe('bun');
  });

  it('addJson throws on malformed JSON string', () => {
    expect(() =>
      mcp.addJson({ name: 'bad', json: '{not valid json' }),
    ).toThrow(/Invalid JSON/);
  });

  it('addFromClaudeDesktop returns a stubbed import summary', () => {
    const result = mcp.addFromClaudeDesktop('user');
    expect(result.imported).toBe(0);
    expect(result.scope).toBe('user');

    const defaulted = mcp.addFromClaudeDesktop();
    expect(defaulted.scope).toBe('global');
  });

  it('serve and resetProjectChoices return stub strings', () => {
    expect(typeof mcp.serve()).toBe('string');
    expect(typeof mcp.resetProjectChoices()).toBe('string');
  });

  it('testConnection returns an error string when the server is unknown', () => {
    const result = mcp.testConnection('does-not-exist');
    expect(result).toMatch(/Error/);
  });

  it('getServerStatus includes an entry per registered server', () => {
    mcp.add({ name: 'alpha', command: 'a' });
    mcp.add({ name: 'beta', command: 'b' });

    const status = mcp.getServerStatus();
    expect(status.alpha).toEqual({ status: 'unknown', pid: null });
    expect(status.beta).toEqual({ status: 'unknown', pid: null });
  });

  it('readProjectConfig returns an empty shape when .mcp.json is missing', () => {
    const projectPath = path.join(tmpDir, 'no-config');
    fs.mkdirSync(projectPath, { recursive: true });

    const config = mcp.readProjectConfig(projectPath);
    expect(config).toEqual({ mcpServers: {} });
  });

  it('saveProjectConfig creates the project directory if it does not exist', () => {
    const projectPath = path.join(tmpDir, 'does-not-exist-yet');
    const config = { mcpServers: { srv: { command: 'x' } } };

    mcp.saveProjectConfig(projectPath, config);
    expect(fs.existsSync(path.join(projectPath, '.mcp.json'))).toBe(true);
  });

  it('service works even when settings.json does not exist', () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greychrist-mcp-fresh-'));
    try {
      const fresh = createMCPService(freshDir);
      expect(fresh.list()).toEqual([]);
      fresh.add({ name: 'bootstrap', command: 'node' });
      expect(fresh.list()).toHaveLength(1);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  describe('multi-account isolation', () => {
    let accountA: string;
    let accountB: string;

    beforeEach(() => {
      accountA = fs.mkdtempSync(path.join(os.tmpdir(), 'greychrist-mcp-acctA-'));
      accountB = fs.mkdtempSync(path.join(os.tmpdir(), 'greychrist-mcp-acctB-'));
      // Initialise both dirs with empty mcpServers
      fs.writeFileSync(path.join(accountA, 'settings.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');
      fs.writeFileSync(path.join(accountB, 'settings.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');
    });

    afterEach(() => {
      fs.rmSync(accountA, { recursive: true, force: true });
      fs.rmSync(accountB, { recursive: true, force: true });
    });

    it('list with per-call configDir reads the correct account settings', () => {
      // Add a server directly to accountA's settings
      fs.writeFileSync(
        path.join(accountA, 'settings.json'),
        JSON.stringify({ mcpServers: { 'acct-a-server': { command: 'node', args: [] } } }),
        'utf-8',
      );

      const servers = mcp.list(accountA);
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('acct-a-server');

      // accountB should remain empty
      expect(mcp.list(accountB)).toHaveLength(0);
    });

    it('add with configDir in params writes to the correct account', () => {
      mcp.add({ name: 'server-for-a', command: 'node', args: [], configDir: accountA });
      mcp.add({ name: 'server-for-b', command: 'deno', args: [], configDir: accountB });

      expect(mcp.list(accountA)).toHaveLength(1);
      expect(mcp.list(accountA)[0].name).toBe('server-for-a');

      expect(mcp.list(accountB)).toHaveLength(1);
      expect(mcp.list(accountB)[0].name).toBe('server-for-b');
    });

    it('get with configDir retrieves from the correct account', () => {
      mcp.add({ name: 'shared-name', command: 'node', args: ['a.js'], configDir: accountA });
      mcp.add({ name: 'shared-name', command: 'deno', args: ['b.ts'], configDir: accountB });

      const serverA = mcp.get('shared-name', accountA);
      expect(serverA.command).toBe('node');

      const serverB = mcp.get('shared-name', accountB);
      expect(serverB.command).toBe('deno');
    });

    it('remove with configDir only removes from the targeted account', () => {
      mcp.add({ name: 'shared-name', command: 'node', args: [], configDir: accountA });
      mcp.add({ name: 'shared-name', command: 'deno', args: [], configDir: accountB });

      mcp.remove('shared-name', accountA);

      expect(mcp.list(accountA)).toHaveLength(0);
      expect(mcp.list(accountB)).toHaveLength(1);
    });

    it('getServerStatus with configDir returns status for the correct account', () => {
      mcp.add({ name: 'alpha', command: 'node', args: [], configDir: accountA });

      const statusA = mcp.getServerStatus(accountA);
      expect(statusA.alpha).toEqual({ status: 'unknown', pid: null });

      const statusB = mcp.getServerStatus(accountB);
      expect(Object.keys(statusB)).toHaveLength(0);
    });

    it('falls back to defaultConfigDir when configDir is omitted', () => {
      // Add to the default dir (mcp was created with configDir = tmpDir)
      mcp.add({ name: 'default-server', command: 'node', args: [] });

      // list() with no arg should see it
      expect(mcp.list()).toHaveLength(1);
      // list() with explicit accountA should not see it
      expect(mcp.list(accountA)).toHaveLength(0);
    });
  });
});
