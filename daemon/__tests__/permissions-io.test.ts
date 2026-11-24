import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPermissionsIOService,
  type PermissionsIOService,
} from '../services/permissions-io';

describe('PermissionsIOService', () => {
  let tmpDir: string;
  let configDir: string;
  let projectPath: string;
  let service: PermissionsIOService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greychrist-perms-test-'));
    configDir = path.join(tmpDir, 'config');
    projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(projectPath, '.claude'), { recursive: true });

    service = createPermissionsIOService();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── getPermissions ─────────────────────────────────────────────────────────

  describe('getPermissions', () => {
    it('returns only user scope when projectPath is omitted', () => {
      const result = service.getPermissions(configDir);
      expect(result).toHaveLength(1);
      expect(result[0].scope).toBe('user');
    });

    it('returns user, project, and local scopes when projectPath is provided', () => {
      const result = service.getPermissions(configDir, projectPath);
      expect(result).toHaveLength(3);
      expect(result.map((r) => r.scope)).toEqual(['user', 'project', 'local']);
    });

    it('returns empty allow/deny arrays when settings files are missing', () => {
      const result = service.getPermissions(configDir, projectPath);
      for (const level of result) {
        expect(level.allow).toEqual([]);
        expect(level.deny).toEqual([]);
      }
    });

    it('reads user-level allow/deny from configDir/settings.json', () => {
      const settingsPath = path.join(configDir, 'settings.json');
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ permissions: { allow: ['Bash(*)', 'Read(*)'], deny: ['Write(*)'] } }),
        'utf-8',
      );

      const result = service.getPermissions(configDir, projectPath);
      const user = result.find((r) => r.scope === 'user')!;
      expect(user.allow).toEqual(['Bash(*)', 'Read(*)']);
      expect(user.deny).toEqual(['Write(*)']);
      expect(user.path).toBe(settingsPath);
    });

    it('reads project-level allow/deny from <projectPath>/.claude/settings.json', () => {
      const settingsPath = path.join(projectPath, '.claude', 'settings.json');
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ permissions: { allow: ['Read(src/*)'] } }),
        'utf-8',
      );

      const result = service.getPermissions(configDir, projectPath);
      const project = result.find((r) => r.scope === 'project')!;
      expect(project.allow).toEqual(['Read(src/*)']);
      expect(project.deny).toEqual([]);
    });

    it('reads local-level allow/deny from <projectPath>/.claude/settings.local.json', () => {
      const settingsPath = path.join(projectPath, '.claude', 'settings.local.json');
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ permissions: { deny: ['WebSearch(*)'] } }),
        'utf-8',
      );

      const result = service.getPermissions(configDir, projectPath);
      const local = result.find((r) => r.scope === 'local')!;
      expect(local.allow).toEqual([]);
      expect(local.deny).toEqual(['WebSearch(*)']);
    });

    it('returns empty arrays when permissions key is absent from file', () => {
      const settingsPath = path.join(configDir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify({ model: 'claude-opus-4' }), 'utf-8');

      const result = service.getPermissions(configDir);
      const user = result.find((r) => r.scope === 'user')!;
      expect(user.allow).toEqual([]);
      expect(user.deny).toEqual([]);
    });

    it('returns correct label strings for each scope', () => {
      const result = service.getPermissions(configDir, projectPath);
      expect(result[0].label).toBe('User Settings');
      expect(result[1].label).toBe('Project Settings');
      expect(result[2].label).toBe('Local Settings');
    });
  });

  // ── updatePermission ───────────────────────────────────────────────────────

  describe('updatePermission', () => {
    it('adds a rule to the user allow list and creates the file', () => {
      service.updatePermission({
        configDir,
        scope: 'user',
        action: 'add',
        behavior: 'allow',
        rule: 'Bash(npm test)',
      });

      const settingsPath = path.join(configDir, 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.permissions.allow).toContain('Bash(npm test)');
    });

    it('adds a rule to the user deny list', () => {
      service.updatePermission({
        configDir,
        scope: 'user',
        action: 'add',
        behavior: 'deny',
        rule: 'WebSearch(*)',
      });

      const settings = JSON.parse(
        fs.readFileSync(path.join(configDir, 'settings.json'), 'utf-8'),
      );
      expect(settings.permissions.deny).toContain('WebSearch(*)');
    });

    it('does not duplicate a rule that already exists', () => {
      service.updatePermission({
        configDir,
        scope: 'user',
        action: 'add',
        behavior: 'allow',
        rule: 'Read(*)',
      });
      service.updatePermission({
        configDir,
        scope: 'user',
        action: 'add',
        behavior: 'allow',
        rule: 'Read(*)',
      });

      const settings = JSON.parse(
        fs.readFileSync(path.join(configDir, 'settings.json'), 'utf-8'),
      );
      const count = settings.permissions.allow.filter((r: string) => r === 'Read(*)').length;
      expect(count).toBe(1);
    });

    it('removes a rule from the allow list', () => {
      // Seed file with existing rules
      fs.writeFileSync(
        path.join(configDir, 'settings.json'),
        JSON.stringify({ permissions: { allow: ['Bash(*)', 'Read(*)'], deny: [] } }),
        'utf-8',
      );

      service.updatePermission({
        configDir,
        scope: 'user',
        action: 'remove',
        behavior: 'allow',
        rule: 'Bash(*)',
      });

      const settings = JSON.parse(
        fs.readFileSync(path.join(configDir, 'settings.json'), 'utf-8'),
      );
      expect(settings.permissions.allow).not.toContain('Bash(*)');
      expect(settings.permissions.allow).toContain('Read(*)');
    });

    it('remove is a no-op when rule does not exist', () => {
      fs.writeFileSync(
        path.join(configDir, 'settings.json'),
        JSON.stringify({ permissions: { allow: ['Read(*)'], deny: [] } }),
        'utf-8',
      );

      // Should not throw
      expect(() =>
        service.updatePermission({
          configDir,
          scope: 'user',
          action: 'remove',
          behavior: 'allow',
          rule: 'nonexistent',
        }),
      ).not.toThrow();

      const settings = JSON.parse(
        fs.readFileSync(path.join(configDir, 'settings.json'), 'utf-8'),
      );
      expect(settings.permissions.allow).toEqual(['Read(*)']);
    });

    it('writes project-scoped rule to <projectPath>/.claude/settings.json', () => {
      service.updatePermission({
        configDir,
        projectPath,
        scope: 'project',
        action: 'add',
        behavior: 'allow',
        rule: 'Read(src/**)',
      });

      const settingsPath = path.join(projectPath, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.permissions.allow).toContain('Read(src/**)');
    });

    it('writes local-scoped rule to <projectPath>/.claude/settings.local.json', () => {
      service.updatePermission({
        configDir,
        projectPath,
        scope: 'local',
        action: 'add',
        behavior: 'deny',
        rule: 'Write(*)',
      });

      const settingsPath = path.join(projectPath, '.claude', 'settings.local.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.permissions.deny).toContain('Write(*)');
    });

    it('preserves other top-level settings keys when updating permissions', () => {
      fs.writeFileSync(
        path.join(configDir, 'settings.json'),
        JSON.stringify({ model: 'claude-opus-4', permissions: { allow: [], deny: [] } }),
        'utf-8',
      );

      service.updatePermission({
        configDir,
        scope: 'user',
        action: 'add',
        behavior: 'allow',
        rule: 'Bash(*)',
      });

      const settings = JSON.parse(
        fs.readFileSync(path.join(configDir, 'settings.json'), 'utf-8'),
      );
      expect(settings.model).toBe('claude-opus-4');
    });

    it('creates intermediate directories for project scope when they do not exist', () => {
      const newProjectPath = path.join(tmpDir, 'new-project');
      // Do NOT pre-create the .claude directory

      service.updatePermission({
        configDir,
        projectPath: newProjectPath,
        scope: 'project',
        action: 'add',
        behavior: 'allow',
        rule: 'Read(*)',
      });

      const settingsPath = path.join(newProjectPath, '.claude', 'settings.json');
      expect(fs.existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.permissions.allow).toContain('Read(*)');
    });
  });
});
