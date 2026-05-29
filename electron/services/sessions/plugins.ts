// Plugin enrichment — read .claude-plugin/plugin.json manifests and infer
// scope from path, so the renderer can show richer info than what the CLI's
// reloadPlugins response carries.

import fs from 'node:fs';
import path from 'node:path';

export interface PluginBase {
  name: string;
  path: string;
  source?: string;
}

export type PluginScope = 'user' | 'project' | 'local' | 'unknown';

export interface EnrichedPlugin extends PluginBase {
  scope: PluginScope;
  version?: string;
  description?: string;
  author?: string;
  authorEmail?: string;
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

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function enrichPlugin(
  plugin: PluginBase,
  options: {
    configDir?: string;
    projectPath?: string;
    readFile?: (p: string) => string;
  } = {},
): EnrichedPlugin {
  const manifest = readPluginManifest(plugin.path, options.readFile);
  const author = typeof manifest?.author === 'string'
    ? { name: manifest.author }
    : manifest?.author ?? {};
  return {
    ...plugin,
    scope: inferScope(plugin.path, options),
    version: manifest?.version,
    description: manifest?.description,
    author: author.name,
    authorEmail: author.email,
  };
}
