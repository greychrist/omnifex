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
});
