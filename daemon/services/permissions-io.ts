import fs from 'node:fs';
import path from 'node:path';

export interface PermissionLevel {
  label: string;
  scope: 'user' | 'project' | 'local';
  path: string;
  allow: string[];
  deny: string[];
}

export interface UpdatePermissionParams {
  configDir?: string;
  projectPath?: string;
  scope: 'user' | 'project' | 'local';
  action: 'add' | 'remove';
  behavior: 'allow' | 'deny';
  rule: string;
}

export interface PermissionsIOService {
  getPermissions(configDir: string, projectPath?: string): PermissionLevel[];
  updatePermission(params: UpdatePermissionParams): void;
}

function readPerms(filePath: string): { allow: string[]; deny: string[] } {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as { permissions?: { allow?: string[]; deny?: string[] } };
    const perms = parsed.permissions ?? {};
    return { allow: perms.allow ?? [], deny: perms.deny ?? [] };
  } catch {
    return { allow: [], deny: [] };
  }
}

function resolveFilePath(
  scope: 'user' | 'project' | 'local',
  configDir: string,
  projectPath: string,
): string {
  if (scope === 'user') return path.join(configDir, 'settings.json');
  if (scope === 'project') return path.join(projectPath, '.claude', 'settings.json');
  return path.join(projectPath, '.claude', 'settings.local.json');
}

export function createPermissionsIOService(): PermissionsIOService {
  function getPermissions(configDir: string, projectPath?: string): PermissionLevel[] {
    if (!configDir) {
      throw new Error('configDir is required for getPermissions');
    }
    const resolvedConfigDir = configDir;
    const levels: PermissionLevel[] = [];

    const userFilePath = path.join(resolvedConfigDir, 'settings.json');
    const userPerms = readPerms(userFilePath);
    levels.push({
      label: 'User Settings',
      scope: 'user',
      path: userFilePath,
      allow: userPerms.allow,
      deny: userPerms.deny,
    });

    if (projectPath) {
      const projFilePath = path.join(projectPath, '.claude', 'settings.json');
      const projPerms = readPerms(projFilePath);
      levels.push({
        label: 'Project Settings',
        scope: 'project',
        path: projFilePath,
        allow: projPerms.allow,
        deny: projPerms.deny,
      });
    }

    if (projectPath) {
      const localFilePath = path.join(projectPath, '.claude', 'settings.local.json');
      const localPerms = readPerms(localFilePath);
      levels.push({
        label: 'Local Settings',
        scope: 'local',
        path: localFilePath,
        allow: localPerms.allow,
        deny: localPerms.deny,
      });
    }

    return levels;
  }

  function updatePermission(params: UpdatePermissionParams): void {
    const {
      configDir,
      projectPath = '',
      scope,
      action,
      behavior,
      rule,
    } = params;

    if (!configDir) {
      throw new Error('configDir is required for updatePermission');
    }
    const resolvedConfigDir = configDir;
    const filePath = resolveFilePath(scope, resolvedConfigDir, projectPath);

    let settings: { permissions?: Partial<Record<'allow' | 'deny', string[]>> } & Record<string, unknown> = {};
    try {
      settings = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as typeof settings;
    } catch {
      // New file — start from empty object
    }

    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.allow) settings.permissions.allow = [];
    if (!settings.permissions.deny) settings.permissions.deny = [];

    const list: string[] = settings.permissions[behavior] ?? [];

    if (action === 'add') {
      if (!list.includes(rule)) list.push(rule);
    } else if (action === 'remove') {
      const idx = list.indexOf(rule);
      if (idx >= 0) list.splice(idx, 1);
    }

    settings.permissions[behavior] = list;

    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
  }

  return { getPermissions, updatePermission };
}
