import fs from 'node:fs';
import path from 'node:path';
import { readModModules, type ModInspection } from './mods';

export interface PluginBase {
  name: string;
  path: string;
  source?: string;
}

export type PluginScope = 'user' | 'project' | 'local' | 'builtin' | 'unknown';

export const BUILTIN_PLUGIN_PATH = 'builtin';

export interface PluginMod {
  modules: string[];
  inspection: ModInspection | null;
}

export interface EnrichedPlugin extends PluginBase {
  scope: PluginScope;
  version?: string;
  description?: string;
  author?: string;
  authorEmail?: string;
  mod: PluginMod | null;
}

interface PluginManifest {
  name?: string;
  version?: string;
  description?: string;
  author?: string | { name?: string; email?: string };
}

export function readPluginManifest(
  pluginPath: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf-8'),
): PluginManifest | null {
  const manifestPath = path.join(pluginPath, '.claude-plugin', 'plugin.json');
  try {
    const raw = readFile(manifestPath);
    return JSON.parse(raw) as PluginManifest;
  } catch {
    return null;
  }
}

export function inferScope(
  pluginPath: string,
  options: { configDir?: string; projectPath?: string } = {},
): PluginScope {
  const { configDir, projectPath } = options;
  if (pluginPath === BUILTIN_PLUGIN_PATH) return 'builtin';
  if (projectPath && isInside(pluginPath, path.join(projectPath, '.claude', 'plugins'))) {
    return 'local';
  }
  if (projectPath && isInside(pluginPath, path.join(projectPath, '.claude-plugin'))) {
    return 'project';
  }
  if (configDir && isInside(pluginPath, path.join(configDir, 'plugins'))) {
    return 'user';
  }
  return 'unknown';
}

interface InstallRecordEntry {
  scope?: string;
  projectPath?: string;
}

export type InstalledPlugins = Map<string, InstallRecordEntry[]>;

// A missing or unreadable file is an empty record, never an error that would empty the plugin list.
export function readInstalledPlugins(
  configDir: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf-8'),
): InstalledPlugins {
  try {
    const raw = JSON.parse(readFile(path.join(configDir, 'plugins', 'installed_plugins.json'))) as {
      plugins?: Record<string, unknown>;
    };
    const out: InstalledPlugins = new Map();
    for (const [id, entries] of Object.entries(raw.plugins ?? {})) {
      if (Array.isArray(entries)) out.set(id, entries as InstallRecordEntry[]);
    }
    return out;
  } catch {
    return new Map();
  }
}

// A project install outranks a user-wide one.
export function scopeFromInstallRecord(
  installed: InstalledPlugins,
  id: string,
  projectPath?: string,
): PluginScope | null {
  const entries = installed.get(id);
  if (!entries) return null;
  if (projectPath) {
    const here = path.resolve(projectPath);
    const forProject = entries.find((e) =>
      (e.scope === 'project' || e.scope === 'local')
      && typeof e.projectPath === 'string'
      && path.resolve(e.projectPath) === here);
    if (forProject) return forProject.scope as PluginScope;
  }
  return entries.some((e) => e.scope === 'user') ? 'user' : null;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Controls (the ESC of ANSI), zero-width, bidi overrides (U+202E spoofing), soft hyphen, BOM.
const INVISIBLE_RE =
  // eslint-disable-next-line no-control-regex -- deliberate: stripping control characters is the point.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

const UNPRINTABLE_NAME = '(unprintable plugin name)';

// Manifests bypass the CLI's marketplace hardening. Strip, don't reject; whitespace becomes a space so words don't merge.
export function sanitizeManifestText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/[\t\n\r]/g, ' ')
    .replace(INVISIBLE_RE, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  return cleaned === '' ? undefined : cleaned;
}

export function enrichPlugin(
  plugin: PluginBase,
  options: {
    configDir?: string;
    projectPath?: string;
    installed?: InstalledPlugins;
    readFile?: (p: string) => string;
  } = {},
): EnrichedPlugin {
  const builtin = plugin.path === BUILTIN_PLUGIN_PATH;
  const manifest = builtin ? null : readPluginManifest(plugin.path, options.readFile);
  const modules = builtin ? null : readModModules(plugin.path, options.readFile);
  const author = typeof manifest?.author === 'string'
    ? { name: manifest.author }
    : manifest?.author ?? {};
  // `path` is not sanitized: it is a real path used for lookup. A local plugin's `name` reaches us unchecked.
  return {
    ...plugin,
    name: sanitizeManifestText(plugin.name) ?? UNPRINTABLE_NAME,
    source: sanitizeManifestText(plugin.source),
    scope: (!builtin && plugin.source && options.installed
      ? scopeFromInstallRecord(options.installed, plugin.source, options.projectPath)
      : null) ?? inferScope(plugin.path, options),
    version: sanitizeManifestText(manifest?.version),
    description: sanitizeManifestText(manifest?.description),
    author: sanitizeManifestText(author.name),
    authorEmail: sanitizeManifestText(author.email),
    mod: modules ? { modules, inspection: null } : null,
  };
}
