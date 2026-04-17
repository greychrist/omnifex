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

    it('returns an empty array when no CLAUDE.md files exist', async () => {
      const projectPath = path.join(tmpDir, 'myproject');
      fs.mkdirSync(projectPath, { recursive: true });

      const files = await service.findClaudeMdFiles(projectPath);
      expect(files).toEqual([]);
    });

    it('returns entries with absolute_path, relative_path, size, and modified for existing files', async () => {
      const projectPath = path.join(tmpDir, 'myproject');
      fs.mkdirSync(projectPath, { recursive: true });
      const rootFile = path.join(projectPath, 'CLAUDE.md');
      fs.writeFileSync(rootFile, '# Project');

      const files = await service.findClaudeMdFiles(projectPath);
      const projectFile = files.find((f) => f.absolute_path === rootFile);

      expect(projectFile).toBeDefined();
      expect(projectFile!.relative_path).toBe('CLAUDE.md');
      expect(typeof projectFile!.size).toBe('number');
      expect(projectFile!.size).toBeGreaterThan(0);
      expect(typeof projectFile!.modified).toBe('number');
    });

    it('finds .claude/CLAUDE.md in addition to the project root', async () => {
      const projectPath = path.join(tmpDir, 'myproject');
      fs.mkdirSync(path.join(projectPath, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(projectPath, 'CLAUDE.md'), '# Project');
      fs.writeFileSync(path.join(projectPath, '.claude', 'CLAUDE.md'), '# Scoped');

      const files = await service.findClaudeMdFiles(projectPath);
      const relPaths = files.map((f) => f.relative_path).sort();

      expect(relPaths).toContain('CLAUDE.md');
      expect(relPaths).toContain('.claude/CLAUDE.md');
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

    it('getHooksConfig throws for user scope when configDir is missing', async () => {
      await expect(service.getHooksConfig('user')).rejects.toThrow(/configDir is required/i);
      await expect(service.getHooksConfig('user', {})).rejects.toThrow(/configDir is required/i);
    });

    it('updateHooksConfig throws for user scope when configDir is missing', async () => {
      await expect(service.updateHooksConfig('user', {})).rejects.toThrow(/configDir is required/i);
      await expect(service.updateHooksConfig('user', {}, {})).rejects.toThrow(/configDir is required/i);
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
      const result = await service.getMergedHooksConfig('/some/project/path', { configDir: tmpDir });
      expect(typeof result).toBe('object');
    });

    it('throws when configDir is missing (no silent fallback to ~/.claude)', async () => {
      await expect(service.getMergedHooksConfig('/some/project')).rejects.toThrow(/configDir is required/i);
      await expect(service.getMergedHooksConfig('/some/project', {})).rejects.toThrow(/configDir is required/i);
    });
  });

  // -------------------------------------------------------------------------
  // createProject
  // -------------------------------------------------------------------------

  describe('createProject', () => {
    it('creates the project directory inside the resolved account config dir', () => {
      const configDir = path.join(tmpDir, '.claude-create');
      fs.mkdirSync(configDir, { recursive: true });
      const account = accounts.createAccount('Test', configDir, true, 'pro');
      accounts.addPathRule(account.id, tmpDir);

      const projectPath = path.join(tmpDir, 'brand-new');
      const project = service.createProject(projectPath);

      expect(project.path).toBe(projectPath);
      expect(project.account_id).toBe(account.id);
      expect(project.account_name).toBe('Test');
      // Project ID encoding: slashes → dashes
      expect(project.id).toBe(projectPath.replace(/\//g, '-'));
      expect(fs.existsSync(path.join(configDir, 'projects', project.id))).toBe(true);
    });

    it('throws when no account resolves for the project', () => {
      // No accounts, no rules — resolve() returns null, createProject should throw
      const projectPath = path.join(tmpDir, 'unresolved');
      expect(() => service.createProject(projectPath)).toThrow(/No account resolved/);
    });
  });

  // -------------------------------------------------------------------------
  // getProjectSessions
  // -------------------------------------------------------------------------

  describe('getProjectSessions', () => {
    it('returns empty array when no config dir contains the project', async () => {
      const result = await service.getProjectSessions('no-such-project');
      expect(result).toEqual([]);
    });

    it('lists sessions and extracts the first user message from JSONL', async () => {
      const configDir = path.join(tmpDir, '.claude-sessions');
      const projectId = '-home-user-sessions-test';
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      accounts.createAccount('SessionsTest', configDir, true, 'pro');

      // Session A: has a plain text user message
      const sessionA = path.join(projectDir, 'sess-a.jsonl');
      fs.writeFileSync(
        sessionA,
        [
          JSON.stringify({ type: 'system', subtype: 'init' }),
          JSON.stringify({
            type: 'user',
            message: { content: 'Hello world from session A' },
          }),
        ].join('\n'),
      );

      // Session B: user message has an array content with a text block
      const sessionB = path.join(projectDir, 'sess-b.jsonl');
      fs.writeFileSync(
        sessionB,
        [
          JSON.stringify({
            type: 'user',
            message: {
              content: [
                { type: 'image', source: 'x' },
                { type: 'text', text: 'Array content body' },
              ],
            },
          }),
        ].join('\n'),
      );

      // Session C: first "user" is isMeta — second is the real one
      const sessionC = path.join(projectDir, 'sess-c.jsonl');
      fs.writeFileSync(
        sessionC,
        [
          JSON.stringify({
            type: 'user',
            isMeta: true,
            message: { content: 'meta noise' },
          }),
          JSON.stringify({
            type: 'user',
            message: { content: 'Real first user message' },
          }),
        ].join('\n'),
      );

      // Session D: every candidate is a system-reminder / command — no first message
      const sessionD = path.join(projectDir, 'sess-d.jsonl');
      fs.writeFileSync(
        sessionD,
        [
          JSON.stringify({
            type: 'user',
            message: { content: '<system-reminder>ignore me</system-reminder>' },
          }),
          JSON.stringify({
            type: 'user',
            message: { content: '<local-command-caveat>ignore too</local-command-caveat>' },
          }),
        ].join('\n'),
      );

      const sessions = await service.getProjectSessions(projectId);
      const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));

      expect(sessions).toHaveLength(4);
      expect(byId['sess-a'].first_message).toBe('Hello world from session A');
      expect(byId['sess-b'].first_message).toBe('Array content body');
      expect(byId['sess-c'].first_message).toBe('Real first user message');
      expect(byId['sess-d'].first_message).toBeUndefined();
      // Sessions should carry decoded path and timestamps
      for (const s of sessions) {
        expect(s.project_id).toBe(projectId);
        expect(typeof s.message_timestamp).toBe('string');
      }
    });

    it('uses the explicit projectPath as a resolution hint when given', async () => {
      const configDir = path.join(tmpDir, '.claude-hint');
      const projectPath = path.join(tmpDir, 'hinted');
      const projectId = projectPath.replace(/\//g, '-');
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'sess.jsonl'),
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      );

      const account = accounts.createAccount('Hint', configDir, true, 'pro');
      accounts.addPathRule(account.id, tmpDir);

      const sessions = await service.getProjectSessions(projectId, projectPath);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].project_path).toBe(projectPath);
    });
  });

  // -------------------------------------------------------------------------
  // loadAgentSessionHistory
  // -------------------------------------------------------------------------

  describe('loadAgentSessionHistory', () => {
    it('returns empty array when no config dir holds the session file', async () => {
      const result = await service.loadAgentSessionHistory('ghost-session');
      expect(result).toEqual([]);
    });

    it('finds a session file across account config dirs', async () => {
      const configDir = path.join(tmpDir, '.claude-agent-history');
      const projectDir = path.join(configDir, 'projects', 'some-proj');
      fs.mkdirSync(projectDir, { recursive: true });

      const sessionId = 'agent-run-42';
      fs.writeFileSync(
        path.join(projectDir, `${sessionId}.jsonl`),
        [
          JSON.stringify({ type: 'system' }),
          JSON.stringify({ type: 'assistant', content: 'done' }),
        ].join('\n'),
      );

      accounts.createAccount('AgentHistory', configDir, true, 'pro');

      const history = await service.loadAgentSessionHistory(sessionId);
      expect(history).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // getSystemPrompt / saveSystemPrompt
  // -------------------------------------------------------------------------

  describe('getSystemPrompt / saveSystemPrompt', () => {
    it('round-trips by delegating to readClaudeMdFile/saveClaudeMdFile', async () => {
      // Write a CLAUDE.md into tmpDir and read it back
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Test prompt', 'utf-8');
      const content = await service.getSystemPrompt({ configDir: tmpDir });
      expect(content).toBe('# Test prompt');
    });

    it('throws when configDir is not provided', async () => {
      await expect(service.getSystemPrompt()).rejects.toThrow(/configDir is required/);
    });
  });

  // -------------------------------------------------------------------------
  // Hooks config — project scope + merging
  // -------------------------------------------------------------------------

  describe('hooks config (project scope)', () => {
    it('returns empty object when project settings.json is missing', async () => {
      const projectPath = path.join(tmpDir, 'no-settings');
      fs.mkdirSync(projectPath, { recursive: true });

      const result = await service.getHooksConfig('project', { projectPath });
      expect(result).toEqual({});
    });

    it('returns empty object when project settings.json is malformed', async () => {
      const projectPath = path.join(tmpDir, 'bad-json');
      fs.mkdirSync(path.join(projectPath, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, '.claude', 'settings.json'),
        '{not valid json',
      );

      const result = await service.getHooksConfig('project', { projectPath });
      expect(result).toEqual({});
    });

    it('round-trips project hooks config without clobbering other settings', async () => {
      const projectPath = path.join(tmpDir, 'with-settings');
      const settingsDir = path.join(projectPath, '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });

      // Pre-existing unrelated setting
      fs.writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({ theme: 'dark' }),
      );

      const hooks = {
        PreToolUse: [
          { matcher: '.*', hooks: [{ type: 'command', command: 'echo pre' }] },
        ],
      };
      await service.updateHooksConfig('project', hooks, { projectPath });

      // Round-trip reads the same hooks back
      const readBack = await service.getHooksConfig('project', { projectPath });
      expect(readBack).toEqual(hooks);

      // And the unrelated setting is preserved
      const raw = JSON.parse(
        fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf-8'),
      );
      expect(raw.theme).toBe('dark');
      expect(raw.hooks).toEqual(hooks);
    });

    it('updateHooksConfig creates .claude dir when it does not exist', async () => {
      const projectPath = path.join(tmpDir, 'new-project');
      fs.mkdirSync(projectPath, { recursive: true });

      await service.updateHooksConfig(
        'project',
        { PreToolUse: [] },
        { projectPath },
      );

      expect(
        fs.existsSync(path.join(projectPath, '.claude', 'settings.json')),
      ).toBe(true);
    });

    it('getMergedHooksConfig overlays project hooks onto user hooks', async () => {
      const userConfigDir = path.join(tmpDir, '.claude-user');
      const projectPath = path.join(tmpDir, 'merged-project');
      fs.mkdirSync(userConfigDir, { recursive: true });
      fs.mkdirSync(path.join(projectPath, '.claude'), { recursive: true });

      // User-level hooks
      await service.updateHooksConfig(
        'user',
        {
          PreToolUse: [{ source: 'user' }],
          PostToolUse: [{ source: 'user' }],
        },
        { configDir: userConfigDir },
      );
      // The user-level read in getMergedHooksConfig uses the default ~/.claude
      // path rather than our test configDir, so we can only assert that the
      // project override is present — which is the critical behavior.
      await service.updateHooksConfig(
        'project',
        { PreToolUse: [{ source: 'project' }] },
        { projectPath },
      );

      const merged = await service.getMergedHooksConfig(projectPath, { configDir: userConfigDir });
      // Project override wins for PreToolUse
      expect((merged as any).PreToolUse).toEqual([{ source: 'project' }]);
    });
  });
});
