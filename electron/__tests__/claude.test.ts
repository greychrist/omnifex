import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService, type AccountsService } from '../services/accounts';
import { createClaudeService, type ClaudeService } from '../services/claude';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('claude service', () => {
  let db: Database;
  let accounts: AccountsService;
  let service: ClaudeService;
  let tmpDir: string;

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    service = createClaudeService(db, accounts);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // -------------------------------------------------------------------------
  // getHomeDirectory
  // -------------------------------------------------------------------------

  describe('getHomeDirectory', () => {
    it('returns a non-empty string', () => {
      const home = service.getHomeDirectory();
      expect(typeof home).toBe('string');
      expect(home.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // listProjects
  // -------------------------------------------------------------------------

  describe('listProjects', () => {
    it('returns an array when no accounts exist', async () => {
      const projects = await service.listProjects();
      expect(Array.isArray(projects)).toBe(true);
    });

    it('returns an array when accounts exist but config dirs are empty', async () => {
      const configDir = path.join(tmpDir, '.claude-test');
      fs.mkdirSync(configDir, { recursive: true });
      accounts.createAccount('Test', configDir, true, 'pro');

      const projects = await service.listProjects();
      expect(Array.isArray(projects)).toBe(true);
    });

    it('discovers projects from account config dir', async () => {
      const configDir = path.join(tmpDir, '.claude-test');
      const projectId = '-home-user-myproject';
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });

      // Create a fake session file
      const sessionFile = path.join(projectDir, 'abc123.jsonl');
      fs.writeFileSync(sessionFile, JSON.stringify({ type: 'system', content: 'init' }) + '\n');

      accounts.createAccount('Test', configDir, true, 'pro');

      const projects = await service.listProjects();
      expect(projects.length).toBeGreaterThanOrEqual(1);
      const found = projects.find((p) => p.id === projectId);
      expect(found).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // loadSessionHistory
  // -------------------------------------------------------------------------

  describe('loadSessionHistory', () => {
    it('returns empty array for non-existent session', async () => {
      const result = await service.loadSessionHistory('nonexistent', 'nonexistent-project');
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('parses a valid jsonl session file', async () => {
      const configDir = path.join(tmpDir, '.claude-test');
      const projectId = 'test-project';
      const sessionId = 'session-001';
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });

      const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
      const lines = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
        JSON.stringify({ type: 'human', content: 'hello' }),
        'invalid json line',
        JSON.stringify({ type: 'assistant', content: 'hi' }),
      ].join('\n');
      fs.writeFileSync(sessionFile, lines);

      accounts.createAccount('Test', configDir, true, 'pro');

      const result = await service.loadSessionHistory(sessionId, projectId);
      // Should parse valid lines and skip invalid
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // findClaudeMdFiles
  // -------------------------------------------------------------------------

  describe('findClaudeMdFiles', () => {
    it('returns an array for any path', async () => {
      const files = await service.findClaudeMdFiles('/some/random/path');
      expect(Array.isArray(files)).toBe(true);
    });

    it('returns candidates including project path and user home', async () => {
      const projectPath = path.join(tmpDir, 'myproject');
      fs.mkdirSync(projectPath, { recursive: true });

      const files = await service.findClaudeMdFiles(projectPath);
      expect(files.length).toBeGreaterThanOrEqual(1);
      // Each entry should have filePath and exists fields
      for (const f of files) {
        expect(f).toHaveProperty('filePath');
        expect(f).toHaveProperty('exists');
        expect(typeof f.filePath).toBe('string');
        expect(typeof f.exists).toBe('boolean');
      }
    });

    it('marks existing CLAUDE.md as exists=true', async () => {
      const projectPath = path.join(tmpDir, 'myproject');
      fs.mkdirSync(projectPath, { recursive: true });
      fs.writeFileSync(path.join(projectPath, 'CLAUDE.md'), '# Project');

      const files = await service.findClaudeMdFiles(projectPath);
      const projectFile = files.find(
        (f) => f.filePath === path.join(projectPath, 'CLAUDE.md'),
      );
      expect(projectFile).toBeDefined();
      expect(projectFile!.exists).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // readClaudeMdFile
  // -------------------------------------------------------------------------

  describe('readClaudeMdFile', () => {
    it('returns empty string for missing file', async () => {
      const result = await service.readClaudeMdFile('/nonexistent/CLAUDE.md');
      expect(result).toBe('');
    });

    it('returns file content for existing file', async () => {
      const filePath = path.join(tmpDir, 'CLAUDE.md');
      fs.writeFileSync(filePath, '# Hello World');

      const result = await service.readClaudeMdFile(filePath);
      expect(result).toBe('# Hello World');
    });
  });

  // -------------------------------------------------------------------------
  // saveClaudeMdFile
  // -------------------------------------------------------------------------

  describe('saveClaudeMdFile', () => {
    it('creates file and reads back content', async () => {
      const filePath = path.join(tmpDir, 'CLAUDE.md');
      const content = '# My Project\n\nSome instructions.';

      await service.saveClaudeMdFile(filePath, content);

      const readBack = await service.readClaudeMdFile(filePath);
      expect(readBack).toBe(content);
    });

    it('creates nested directories if needed', async () => {
      const filePath = path.join(tmpDir, 'nested', 'dir', 'CLAUDE.md');
      await service.saveClaudeMdFile(filePath, 'content');
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getClaudeSettings
  // -------------------------------------------------------------------------

  describe('getClaudeSettings', () => {
    it('returns empty object for missing settings file', async () => {
      const result = await service.getClaudeSettings({
        configDir: path.join(tmpDir, 'nonexistent'),
      });
      expect(typeof result).toBe('object');
      expect(result).not.toBeNull();
    });

    it('reads settings from a config dir', async () => {
      const configDir = path.join(tmpDir, '.claude-test');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'settings.json'),
        JSON.stringify({ theme: 'dark' }),
      );

      const result = await service.getClaudeSettings({ configDir });
      expect((result as any).theme).toBe('dark');
    });
  });

  // -------------------------------------------------------------------------
  // saveClaudeSettings
  // -------------------------------------------------------------------------

  describe('saveClaudeSettings', () => {
    it('writes and reads back settings', async () => {
      const configDir = path.join(tmpDir, '.claude-settings-test');
      fs.mkdirSync(configDir, { recursive: true });

      const settings = { theme: 'light', fontSize: 14 };
      await service.saveClaudeSettings(settings, { configDir });

      const readBack = await service.getClaudeSettings({ configDir });
      expect((readBack as any).theme).toBe('light');
      expect((readBack as any).fontSize).toBe(14);
    });
  });

  // -------------------------------------------------------------------------
  // checkClaudeVersion
  // -------------------------------------------------------------------------

  describe('checkClaudeVersion', () => {
    it('returns an object with installed boolean', async () => {
      const result = await service.checkClaudeVersion();
      expect(typeof result).toBe('object');
      expect(result).not.toBeNull();
      expect(typeof result.installed).toBe('boolean');
    });

    it('returns version string or null', async () => {
      const result = await service.checkClaudeVersion();
      expect(result.version === null || typeof result.version === 'string').toBe(true);
    });

    it('returns path string or null', async () => {
      const result = await service.checkClaudeVersion();
      expect(result.path === null || typeof result.path === 'string').toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getHooksConfig / updateHooksConfig
  // -------------------------------------------------------------------------

  describe('getHooksConfig / updateHooksConfig', () => {
    it('returns empty object for missing hooks', async () => {
      const result = await service.getHooksConfig('user', {
        configDir: path.join(tmpDir, 'nonexistent'),
      });
      expect(typeof result).toBe('object');
    });

    it('round-trips hooks config', async () => {
      const configDir = path.join(tmpDir, '.claude-hooks-test');
      fs.mkdirSync(configDir, { recursive: true });

      const hooks = { PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: 'echo hi' }] }] };
      await service.updateHooksConfig('user', hooks, { configDir });

      const result = await service.getHooksConfig('user', { configDir });
      expect(result).toEqual(hooks);
    });
  });

  // -------------------------------------------------------------------------
  // validateHookCommand
  // -------------------------------------------------------------------------

  describe('validateHookCommand', () => {
    it('returns valid=true for non-empty command', () => {
      const result = service.validateHookCommand('echo hello');
      expect(result.valid).toBe(true);
    });

    it('returns valid=false for empty command', () => {
      const result = service.validateHookCommand('');
      expect(result.valid).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getMergedHooksConfig
  // -------------------------------------------------------------------------

  describe('getMergedHooksConfig', () => {
    it('returns an object', async () => {
      const result = await service.getMergedHooksConfig('/some/project/path');
      expect(typeof result).toBe('object');
    });
  });
});
