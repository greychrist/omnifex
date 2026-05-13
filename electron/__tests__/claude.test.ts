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
      accounts.createAccount('Test', configDir, 'pro');

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

      accounts.createAccount('Test', configDir, 'pro');

      const projects = await service.listProjects();
      expect(projects.length).toBeGreaterThanOrEqual(1);
      const found = projects.find((p) => p.id === projectId);
      expect(found).toBeDefined();
    });

    // Regression: Claude Code's project-dir encoding (/ → -) is lossy.
    // `-Users-greg-Repos-work-pi-tuitive-fe` could decode to either
    // `/Users/greg/Repos/work/pi-tuitive-fe` (correct) or
    // `/Users/greg/Repos/work/pi/tuitive/fe` (naive). The authoritative
    // recovery is the `cwd` field on any JSONL entry inside the project
    // dir; only the JSONL knows where the dashes really sit.
    it('recovers a project path with literal dashes from the JSONL cwd field', async () => {
      const configDir = path.join(tmpDir, '.claude-recover');
      const projectId = '-Users-greg-Repos-work-pi-tuitive-fe';
      const realPath = '/Users/greg/Repos/work/pi-tuitive-fe';
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });

      const sessionFile = path.join(projectDir, 'sess-1.jsonl');
      fs.writeFileSync(
        sessionFile,
        JSON.stringify({ type: 'user', cwd: realPath, message: { role: 'user', content: 'hi' } }) + '\n',
      );

      accounts.createAccount('Test', configDir, 'pro');

      const projects = await service.listProjects();
      const found = projects.find((p) => p.id === projectId);
      expect(found).toBeDefined();
      expect(found!.path).toBe(realPath);
    });

    // Regression: when a project folder is renamed (e.g. greychrist → omnifex),
    // Claude continues writing to the SAME encoded project-id dir but with the
    // new cwd. Older JSONLs in that dir still carry the pre-rename cwd. The
    // recovered path must reflect the CURRENT name — i.e. the newest JSONL's
    // cwd wins, not whichever file happens to sort alphabetically first by
    // its random UUID. Without this, a renamed project shows in the UI under
    // its old path and silently collides with any sibling using the old name.
    it('prefers the newest JSONL cwd so a folder rename is reflected immediately', async () => {
      const configDir = path.join(tmpDir, '.claude-rename');
      const projectId = '-Users-greg-Repos-personal-omnifex';
      const oldPath = '/Users/greg/Repos/personal/greychrist';
      const newPath = '/Users/greg/Repos/personal/omnifex';
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });

      // The OLDER session (alphabetically first by UUID) carries the stale cwd.
      const olderFile = path.join(projectDir, '00000000-old-session.jsonl');
      fs.writeFileSync(
        olderFile,
        JSON.stringify({ type: 'user', cwd: oldPath, message: { role: 'user', content: 'old' } }) + '\n',
      );
      const olderTime = new Date('2026-01-01T00:00:00Z');
      fs.utimesSync(olderFile, olderTime, olderTime);

      // The NEWER session (alphabetically last) carries the post-rename cwd.
      const newerFile = path.join(projectDir, 'ffffffff-new-session.jsonl');
      fs.writeFileSync(
        newerFile,
        JSON.stringify({ type: 'user', cwd: newPath, message: { role: 'user', content: 'new' } }) + '\n',
      );
      const newerTime = new Date('2026-05-01T00:00:00Z');
      fs.utimesSync(newerFile, newerTime, newerTime);

      accounts.createAccount('Test', configDir, 'pro');

      const projects = await service.listProjects();
      const found = projects.find((p) => p.id === projectId);
      expect(found).toBeDefined();
      expect(found!.path).toBe(newPath);
    });

    it('falls back to naive decode when no JSONL exists in the project dir', async () => {
      const configDir = path.join(tmpDir, '.claude-empty');
      const projectId = '-Users-greg-myproject';
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });

      accounts.createAccount('Test', configDir, 'pro');

      const projects = await service.listProjects();
      const found = projects.find((p) => p.id === projectId);
      expect(found).toBeDefined();
      // No JSONL → no cwd to recover; naive decode is best-effort.
      expect(found!.path).toBe('/Users/greg/myproject');
    });

    it('falls back to naive decode when JSONL has no cwd field', async () => {
      const configDir = path.join(tmpDir, '.claude-no-cwd');
      const projectId = '-Users-greg-myproject';
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'sess.jsonl'),
        JSON.stringify({ type: 'system', subtype: 'init' }) + '\n',
      );

      accounts.createAccount('Test', configDir, 'pro');

      const projects = await service.listProjects();
      const found = projects.find((p) => p.id === projectId);
      expect(found!.path).toBe('/Users/greg/myproject');
    });

    it('falls back to naive decode when JSONL is corrupt', async () => {
      const configDir = path.join(tmpDir, '.claude-corrupt');
      const projectId = '-Users-greg-myproject';
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'sess.jsonl'),
        'not valid json at all\n',
      );

      accounts.createAccount('Test', configDir, 'pro');

      const projects = await service.listProjects();
      const found = projects.find((p) => p.id === projectId);
      expect(found!.path).toBe('/Users/greg/myproject');
    });
  });

  // -------------------------------------------------------------------------
  // loadSessionHistory
  // -------------------------------------------------------------------------

  describe('loadSessionHistory', () => {
    it('throws NoAccountError when projectPath cannot be resolved to an account', async () => {
      await expect(
        service.loadSessionHistory('nonexistent', 'nonexistent-project'),
      ).rejects.toThrow(/no claude account/i);
    });

    it('returns empty array when the resolved account has no JSONL for the session', async () => {
      const configDir = path.join(tmpDir, '.claude-no-jsonl');
      const projectPath = path.join(tmpDir, 'no-jsonl-proj');
      const projectId = projectPath.replace(/\//g, '-');
      const account = accounts.createAccount('Test', configDir, 'pro');
      accounts.addPathRule(account.id, tmpDir);

      const result = await service.loadSessionHistory('ghost', projectId, projectPath);
      expect(result).toEqual([]);
    });

    it('parses a valid jsonl session file', async () => {
      const configDir = path.join(tmpDir, '.claude-test');
      const projectPath = path.join(tmpDir, 'test-project');
      const projectId = projectPath.replace(/\//g, '-');
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

      const account = accounts.createAccount('Test', configDir, 'pro');
      accounts.addPathRule(account.id, tmpDir);

      const result = await service.loadSessionHistory(sessionId, projectId, projectPath);
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
      const account = accounts.createAccount('Test', configDir, 'pro');
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
    it('throws NoAccountError when no projectPath is provided (cannot resolve)', async () => {
      await expect(
        service.getProjectSessions('no-such-project'),
      ).rejects.toThrow(/no claude account/i);
    });

    it('returns empty array when the resolved account has no sessions on disk yet', async () => {
      const configDir = path.join(tmpDir, '.claude-empty');
      const projectPath = path.join(tmpDir, 'empty-project');
      const projectId = projectPath.replace(/\//g, '-');
      const account = accounts.createAccount('Empty', configDir, 'pro');
      accounts.addPathRule(account.id, tmpDir);

      const result = await service.getProjectSessions(projectId, projectPath);
      expect(result).toEqual([]);
    });

    it('lists sessions and extracts the first user message from JSONL', async () => {
      const configDir = path.join(tmpDir, '.claude-sessions');
      const projectPath = path.join(tmpDir, 'sessions-test');
      const projectId = projectPath.replace(/\//g, '-');
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      const account = accounts.createAccount('SessionsTest', configDir, 'pro');
      accounts.addPathRule(account.id, tmpDir);

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

      const sessions = await service.getProjectSessions(projectId, projectPath);
      const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));

      expect(sessions).toHaveLength(4);
      expect(byId['sess-a'].first_message).toBe('Hello world from session A');
      expect(byId['sess-b'].first_message).toBe('Array content body');
      expect(byId['sess-c'].first_message).toBe('Real first user message');
      expect(byId['sess-d'].first_message).toBeUndefined();
      // Sessions should carry decoded path and timestamps
      for (const s of sessions) {
        expect(s.project_id).toBe(projectId);
        expect(typeof s.last_timestamp).toBe('string');
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

      const account = accounts.createAccount('Hint', configDir, 'pro');
      accounts.addPathRule(account.id, tmpDir);

      const sessions = await service.getProjectSessions(projectId, projectPath);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].project_path).toBe(projectPath);
    });

    // Regression: when the same projectId directory exists under more than one
    // account's configDir (e.g. a stray run under the wrong account left a few
    // JSONLs behind), getProjectSessions must read from the configDir resolved
    // by the path rule, NOT from whichever directory happens to be alphabetically
    // first in listAccounts() order. This was the WIN-project bug: 264 real
    // sessions in .claude-personal hidden by 2 stray sessions in .claude-local.
    it('reads sessions from the path-rule-resolved configDir, not the first dir whose project folder exists', async () => {
      const personalDir = path.join(tmpDir, '.claude-personal');
      const localDir = path.join(tmpDir, '.claude-local');
      const projectPath = path.join(tmpDir, 'Repos', 'personal', 'WIN');
      const projectId = projectPath.replace(/\//g, '-');

      // Stray (wrong-account) sessions under .claude-local — alphabetically first.
      const localProjectDir = path.join(localDir, 'projects', projectId);
      fs.mkdirSync(localProjectDir, { recursive: true });
      fs.writeFileSync(
        path.join(localProjectDir, 'stray-1.jsonl'),
        JSON.stringify({ type: 'user', message: { content: 'stray' } }),
      );
      fs.writeFileSync(
        path.join(localProjectDir, 'stray-2.jsonl'),
        JSON.stringify({ type: 'user', message: { content: 'stray' } }),
      );

      // Real sessions under .claude-personal — what the path rule should resolve to.
      const personalProjectDir = path.join(personalDir, 'projects', projectId);
      fs.mkdirSync(personalProjectDir, { recursive: true });
      for (const id of ['real-1', 'real-2', 'real-3']) {
        fs.writeFileSync(
          path.join(personalProjectDir, `${id}.jsonl`),
          JSON.stringify({ type: 'user', message: { content: id } }),
        );
      }

      // Both accounts exist. Path rule binds ~/Repos/personal → Personal.
      // Note: 'Local' sorts before 'Personal' in listAccounts() ORDER BY name.
      const personal = accounts.createAccount('Personal', personalDir, 'pro');
      accounts.createAccount('Local', localDir, 'pro');
      accounts.addPathRule(personal.id, path.join(tmpDir, 'Repos', 'personal'));

      const sessions = await service.getProjectSessions(projectId, projectPath);
      const ids = sessions.map((s) => s.id).sort();
      expect(ids).toEqual(['real-1', 'real-2', 'real-3']);
    });

    it('throws NoAccountError when no path rule resolves the project path', async () => {
      const personalDir = path.join(tmpDir, '.claude-personal');
      accounts.createAccount('Personal', personalDir, 'pro');
      // No path rule covering /Some/Other/Path.

      const orphanPath = path.join(tmpDir, 'orphan');
      const orphanId = orphanPath.replace(/\//g, '-');

      await expect(
        service.getProjectSessions(orphanId, orphanPath),
      ).rejects.toThrow(/no claude account/i);
    });

    it('throws NoAccountError when projectPath is not provided (no resolution possible)', async () => {
      const configDir = path.join(tmpDir, '.claude-no-path');
      const projectId = 'some-proj';
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'sess.jsonl'),
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      );
      accounts.createAccount('Test', configDir, 'pro');

      await expect(
        service.getProjectSessions(projectId),
      ).rejects.toThrow(/no claude account/i);
    });
  });

  // -------------------------------------------------------------------------
  // loadAgentSessionHistory
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // deleteSession
  // -------------------------------------------------------------------------

  describe('deleteSession', () => {
    // Helper: register a configDir with the accounts service and bind it
    // to the test's tmpDir via a path rule so any projectPath under tmpDir
    // resolves to this account.
    function bindAccount(name: string, configDir: string) {
      const account = accounts.createAccount(name, configDir, 'pro');
      accounts.addPathRule(account.id, tmpDir);
    }

    it('removes the JSONL file for the given session', async () => {
      const configDir = path.join(tmpDir, '.claude-delete');
      const projectPath = path.join(tmpDir, 'delete-proj');
      const projectId = projectPath.replace(/\//g, '-');
      const sessionId = 'sess-to-go';
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
      fs.writeFileSync(jsonlPath, JSON.stringify({ type: 'system' }) + '\n');

      bindAccount('Test', configDir);

      await service.deleteSession(sessionId, projectId, projectPath);
      expect(fs.existsSync(jsonlPath)).toBe(false);
    });

    it('cascade-deletes the .summary.json sidecar when present', async () => {
      const configDir = path.join(tmpDir, '.claude-delete-summary');
      const projectPath = path.join(tmpDir, 'sum-proj');
      const projectId = projectPath.replace(/\//g, '-');
      const sessionId = 'sess-with-summary';
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
      const sidecarPath = path.join(projectDir, `${sessionId}.summary.json`);
      fs.writeFileSync(jsonlPath, JSON.stringify({ type: 'system' }) + '\n');
      fs.writeFileSync(sidecarPath, JSON.stringify({ version: 1, headline: 'h', paragraph: 'p' }));

      bindAccount('Test', configDir);

      await service.deleteSession(sessionId, projectId, projectPath);
      expect(fs.existsSync(jsonlPath)).toBe(false);
      expect(fs.existsSync(sidecarPath)).toBe(false);
    });

    it('cascade-deletes the .todo.json ride-along when present', async () => {
      const configDir = path.join(tmpDir, '.claude-delete-todo');
      const projectPath = path.join(tmpDir, 'todo-proj');
      const projectId = projectPath.replace(/\//g, '-');
      const sessionId = 'sess-with-todo';
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
      const todoPath = path.join(projectDir, `${sessionId}.todo.json`);
      fs.writeFileSync(jsonlPath, JSON.stringify({ type: 'system' }) + '\n');
      fs.writeFileSync(todoPath, JSON.stringify([{ task: 'x', status: 'pending' }]));

      bindAccount('Test', configDir);

      await service.deleteSession(sessionId, projectId, projectPath);
      expect(fs.existsSync(jsonlPath)).toBe(false);
      expect(fs.existsSync(todoPath)).toBe(false);
    });

    it('succeeds quietly when the sidecars are absent', async () => {
      const configDir = path.join(tmpDir, '.claude-delete-no-extras');
      const projectPath = path.join(tmpDir, 'plain-proj');
      const projectId = projectPath.replace(/\//g, '-');
      const sessionId = 'sess-bare';
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
      fs.writeFileSync(jsonlPath, JSON.stringify({ type: 'system' }) + '\n');

      bindAccount('Test', configDir);

      await expect(service.deleteSession(sessionId, projectId, projectPath)).resolves.not.toThrow();
      expect(fs.existsSync(jsonlPath)).toBe(false);
    });

    it('throws when the JSONL file does not exist', async () => {
      const configDir = path.join(tmpDir, '.claude-delete-missing');
      const projectPath = path.join(tmpDir, 'missing-proj');
      const projectId = projectPath.replace(/\//g, '-');
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      bindAccount('Test', configDir);

      await expect(service.deleteSession('ghost', projectId, projectPath)).rejects.toThrow();
    });

    it('throws NoAccountError when the project path does not resolve to any account', async () => {
      // No accounts and no rules → no configDir resolves.
      await expect(
        service.deleteSession('any', 'nope', path.join(tmpDir, 'unbound')),
      ).rejects.toThrow(/no claude account/i);
    });

    it('does not delete unrelated session files in the same project dir', async () => {
      const configDir = path.join(tmpDir, '.claude-delete-isolation');
      const projectPath = path.join(tmpDir, 'iso-proj');
      const projectId = projectPath.replace(/\//g, '-');
      const sessionA = 'keep-me';
      const sessionB = 'delete-me';
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      const jsonlA = path.join(projectDir, `${sessionA}.jsonl`);
      const jsonlB = path.join(projectDir, `${sessionB}.jsonl`);
      const sidecarA = path.join(projectDir, `${sessionA}.summary.json`);
      fs.writeFileSync(jsonlA, JSON.stringify({ type: 'system' }) + '\n');
      fs.writeFileSync(jsonlB, JSON.stringify({ type: 'system' }) + '\n');
      fs.writeFileSync(sidecarA, JSON.stringify({ version: 1, headline: 'h', paragraph: 'p' }));

      bindAccount('Test', configDir);

      await service.deleteSession(sessionB, projectId, projectPath);
      expect(fs.existsSync(jsonlA)).toBe(true);
      expect(fs.existsSync(sidecarA)).toBe(true);
      expect(fs.existsSync(jsonlB)).toBe(false);
    });
  });

  describe('deleteProject', () => {
    it('removes the entire <configDir>/projects/<projectId> directory', async () => {
      const configDir = path.join(tmpDir, '.claude-delete-project');
      const projectPath = path.join(tmpDir, 'proj-to-go');
      const projectId = projectPath.replace(/\//g, '-');
      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });
      // Drop a few session files so we can prove the recursive delete.
      fs.writeFileSync(path.join(projectDir, 'a.jsonl'), '{}\n');
      fs.writeFileSync(path.join(projectDir, 'b.jsonl'), '{}\n');
      fs.writeFileSync(path.join(projectDir, 'a.summary.json'), '{}');

      const account = accounts.createAccount('DelTest', configDir, 'pro');

      await service.deleteProject({ accountId: account.id, projectId });

      expect(fs.existsSync(projectDir)).toBe(false);
      // Sibling project dirs in the same configDir are untouched.
      expect(fs.existsSync(path.join(configDir, 'projects'))).toBe(true);
    });

    it('is idempotent when the project directory is already gone', async () => {
      const configDir = path.join(tmpDir, '.claude-delete-missing-proj');
      fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
      const account = accounts.createAccount('DelTest', configDir, 'pro');

      await expect(
        service.deleteProject({ accountId: account.id, projectId: '-already-gone' }),
      ).resolves.not.toThrow();
    });

    it('rejects projectIds containing path separators or traversal', async () => {
      const configDir = path.join(tmpDir, '.claude-delete-traversal');
      fs.mkdirSync(configDir, { recursive: true });
      const account = accounts.createAccount('DelTest', configDir, 'pro');

      const bad = ['', '..', '../escape', 'has/slash', '.', '   '];
      for (const projectId of bad) {
        await expect(
          service.deleteProject({ accountId: account.id, projectId }),
        ).rejects.toThrow();
      }
    });

    it('throws when the account id does not exist', async () => {
      await expect(
        service.deleteProject({ accountId: 999_999, projectId: '-foo' }),
      ).rejects.toThrow(/account/i);
    });

    it('does not touch sibling project directories under the same account', async () => {
      const configDir = path.join(tmpDir, '.claude-delete-siblings');
      const projectsDir = path.join(configDir, 'projects');
      fs.mkdirSync(path.join(projectsDir, '-keep'), { recursive: true });
      fs.mkdirSync(path.join(projectsDir, '-go'), { recursive: true });
      fs.writeFileSync(path.join(projectsDir, '-keep', 's.jsonl'), '{}\n');
      fs.writeFileSync(path.join(projectsDir, '-go', 's.jsonl'), '{}\n');

      const account = accounts.createAccount('DelTest', configDir, 'pro');

      await service.deleteProject({ accountId: account.id, projectId: '-go' });

      expect(fs.existsSync(path.join(projectsDir, '-go'))).toBe(false);
      expect(fs.existsSync(path.join(projectsDir, '-keep', 's.jsonl'))).toBe(true);
    });
  });

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

      accounts.createAccount('AgentHistory', configDir, 'pro');

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
