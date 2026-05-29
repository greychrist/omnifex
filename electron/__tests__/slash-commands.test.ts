import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSlashCommandsService, type SlashCommandsService } from '../services/slash-commands';

describe('slash commands service', () => {
  let tmpDir: string;
  let configDir: string;
  let service: SlashCommandsService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greychrist-slash-test-'));
    configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(path.join(configDir, 'commands'), { recursive: true });

    service = createSlashCommandsService();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('list returns empty array when no commands exist', () => {
    const commands = service.list(undefined, configDir);
    expect(Array.isArray(commands)).toBe(true);
    expect(commands).toHaveLength(0);
  });

  it('save creates a command and list returns it', () => {
    service.save({
      scope: 'user',
      name: 'greet',
      namespace: 'custom',
      content: 'Say hello to $ARGUMENTS',
      description: 'Greets the user',
      allowedTools: 'read_file',
      configDir,
    });

    const commands = service.list(undefined, configDir);
    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('greet');
    expect(commands[0].description).toBe('Greets the user');
    expect(commands[0].content).toBe('Say hello to $ARGUMENTS');
  });

  it('get retrieves a command by id', () => {
    const saved = service.save({
      scope: 'user',
      name: 'test-cmd',
      namespace: 'ns',
      content: 'Do something',
      description: 'A test command',
      allowedTools: '',
      configDir,
    });

    const retrieved = service.get(saved.id, configDir);
    expect(retrieved.name).toBe('test-cmd');
    expect(retrieved.id).toBe(saved.id);
  });

  it('delete removes a command', () => {
    const saved = service.save({
      scope: 'user',
      name: 'bye',
      namespace: 'custom',
      content: 'Goodbye',
      description: 'Farewell command',
      allowedTools: '',
      configDir,
    });

    service.delete(saved.id, undefined, configDir);

    const commands = service.list(undefined, configDir);
    expect(commands.find((c) => c.id === saved.id)).toBeUndefined();
  });

  it('save with projectPath stores command in project directory', () => {
    const projectPath = path.join(tmpDir, 'my-project');
    fs.mkdirSync(path.join(projectPath, '.claude', 'commands'), { recursive: true });

    service.save({
      scope: 'project',
      name: 'deploy',
      namespace: 'ops',
      content: 'Deploy to production',
      description: 'Run deployment',
      allowedTools: 'bash',
      projectPath,
    });

    const projectCommands = service.list(projectPath, configDir);
    expect(projectCommands.some((c) => c.name === 'deploy')).toBe(true);
  });

  it('list with projectPath returns project and global commands', () => {
    // Global command
    service.save({
      scope: 'user',
      name: 'global-cmd',
      namespace: 'g',
      content: 'Global',
      description: 'A global command',
      allowedTools: '',
      configDir,
    });

    // Project command
    const projectPath = path.join(tmpDir, 'proj2');
    fs.mkdirSync(path.join(projectPath, '.claude', 'commands'), { recursive: true });

    service.save({
      scope: 'project',
      name: 'proj-cmd',
      namespace: 'p',
      content: 'Project',
      description: 'A project command',
      allowedTools: '',
      projectPath,
    });

    const all = service.list(projectPath, configDir);
    const names = all.map((c) => c.name);
    expect(names).toContain('global-cmd');
    expect(names).toContain('proj-cmd');
  });

  it('markdown file has correct frontmatter format', () => {
    service.save({
      scope: 'user',
      name: 'check-format',
      namespace: 'test',
      content: 'Content here',
      description: 'Format check',
      allowedTools: 'read_file, write_file',
      configDir,
    });

    const commandsDir = path.join(configDir, 'commands');
    const files = fs.readdirSync(commandsDir);
    expect(files).toHaveLength(1);

    const content = fs.readFileSync(path.join(commandsDir, files[0]), 'utf-8');
    expect(content).toContain('---');
    expect(content).toContain('description:');
    expect(content).toContain('allowed_tools:');
    expect(content).toContain('Content here');
  });

  it('user-scoped save throws when configDir is omitted (no default-account fallback)', () => {
    // Per CLAUDE.md "Multi-Account Rules": there is no silent fallback to a
    // default account or to ~/.claude. User-scoped commands need an explicit
    // configDir so they land in the right account's tree.
    expect(() =>
      service.save({
        scope: 'user',
        name: 'no-config',
        namespace: 'x',
        content: '',
        description: '',
        allowedTools: '',
      }),
    ).toThrow(/configDir is required/);

    expect(() => service.get('user:x:no-config')).toThrow(/configDir is required/);
    expect(() => service.delete('user:x:no-config')).toThrow(/configDir is required/);
  });

  it('list silently skips user-scope when configDir is omitted (project-only listing is valid)', () => {
    // list() is the one read path that legitimately needs to work without a
    // configDir — e.g. when no project is open the renderer still calls
    // list() with no args. We return an empty array (user-scope skipped)
    // rather than throwing, so the picker just shows nothing.
    const commands = service.list();
    expect(commands).toEqual([]);
  });

  describe('skill discovery', () => {
    it('list includes project skills (.claude/skills/<name>/SKILL.md) as project-scoped', () => {
      // Skills live as folders under <projectPath>/.claude/skills/<skillName>/
      // with a SKILL.md frontmatter file. The CLI exposes them
      // alongside built-in slash commands, but with no scope info — so the
      // renderer mislabels them as "default". Including them here lets the
      // picker's dedup re-tag them as project.
      const projectPath = path.join(tmpDir, 'proj-skills');
      const skillDir = path.join(projectPath, '.claude', 'skills', 'omnifex-release');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: omnifex-release\ndescription: Cut a new OmniFex release\n---\n# Body\n',
        'utf-8',
      );

      const all = service.list(projectPath);
      const skill = all.find((c) => c.name === 'omnifex-release');
      expect(skill).toBeTruthy();
      expect(skill?.scope).toBe('project');
      expect(skill?.full_command).toBe('/omnifex-release');
      expect(skill?.description).toBe('Cut a new OmniFex release');
    });

    it('list includes user skills (<configDir>/skills/<name>/SKILL.md) as user-scoped', () => {
      const skillDir = path.join(configDir, 'skills', 'global-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: global-skill\ndescription: A user-level skill\n---\nBody\n',
        'utf-8',
      );

      const all = service.list(undefined, configDir);
      const skill = all.find((c) => c.name === 'global-skill');
      expect(skill).toBeTruthy();
      expect(skill?.scope).toBe('user');
    });

    it('skips skill folders missing SKILL.md', () => {
      const projectPath = path.join(tmpDir, 'proj-broken-skill');
      const skillDir = path.join(projectPath, '.claude', 'skills', 'no-manifest');
      fs.mkdirSync(skillDir, { recursive: true });
      // No SKILL.md — should be ignored.

      const all = service.list(projectPath);
      expect(all.find((c) => c.name === 'no-manifest')).toBeUndefined();
    });
  });

  describe('multi-account isolation', () => {
    let accountADir: string;
    let accountBDir: string;

    beforeEach(() => {
      accountADir = path.join(tmpDir, 'account-a');
      accountBDir = path.join(tmpDir, 'account-b');
      fs.mkdirSync(path.join(accountADir, 'commands'), { recursive: true });
      fs.mkdirSync(path.join(accountBDir, 'commands'), { recursive: true });
    });

    it('list with different configDirs returns different results', () => {
      // Write a command file directly into each account's commands dir
      fs.writeFileSync(
        path.join(accountADir, 'commands', 'cmd-a.md'),
        '---\ndescription: Account A command\nallowed_tools: \n---\nDo A things\n',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(accountBDir, 'commands', 'cmd-b.md'),
        '---\ndescription: Account B command\nallowed_tools: \n---\nDo B things\n',
        'utf-8'
      );

      const listA = service.list(undefined, accountADir);
      const listB = service.list(undefined, accountBDir);

      const namesA = listA.map((c) => c.name);
      const namesB = listB.map((c) => c.name);

      expect(namesA).toContain('cmd-a');
      expect(namesA).not.toContain('cmd-b');
      expect(namesB).toContain('cmd-b');
      expect(namesB).not.toContain('cmd-a');
    });

    it('save with configDir writes to the specified directory', () => {
      service.save({
        scope: 'user',
        name: 'account-cmd',
        namespace: 'user',
        content: 'Account-specific content',
        description: 'Account command',
        allowedTools: '',
        configDir: accountADir,
      });

      // Should exist in accountA
      const accountAFiles = fs.readdirSync(path.join(accountADir, 'commands'));
      expect(accountAFiles).toContain('account-cmd.md');

      // Should NOT exist in accountB or default configDir
      const accountBFiles = fs.readdirSync(path.join(accountBDir, 'commands'));
      expect(accountBFiles).not.toContain('account-cmd.md');

      const defaultFiles = fs.readdirSync(path.join(configDir, 'commands'));
      expect(defaultFiles).not.toContain('account-cmd.md');
    });

    it('get with configDir reads from the specified directory', () => {
      // Save a command to accountA via configDir param
      const saved = service.save({
        scope: 'user',
        name: 'get-test',
        namespace: 'user',
        content: 'Get test content',
        description: 'Get test',
        allowedTools: '',
        configDir: accountADir,
      });

      // Should be retrievable with accountADir
      const retrieved = service.get(saved.id, accountADir);
      expect(retrieved.name).toBe('get-test');
      expect(retrieved.content).toBe('Get test content');

      // Should NOT be found in accountB (throws)
      expect(() => service.get(saved.id, accountBDir)).toThrow();
    });

    it('delete with configDir removes from the specified directory', () => {
      // Save to accountA
      const saved = service.save({
        scope: 'user',
        name: 'delete-test',
        namespace: 'user',
        content: 'Delete me',
        description: 'Delete test',
        allowedTools: '',
        configDir: accountADir,
      });

      // Confirm it exists
      expect(fs.existsSync(path.join(accountADir, 'commands', 'delete-test.md'))).toBe(true);

      // Delete with configDir
      service.delete(saved.id, undefined, accountADir);

      // Confirm it's gone
      expect(fs.existsSync(path.join(accountADir, 'commands', 'delete-test.md'))).toBe(false);
    });
  });
});
