// Plugin enrichment — read .claude-plugin/plugin.json manifests and each
// plugin's scope, so the renderer can show richer info than what the CLI's
// reloadPlugins response carries.

import fs from 'node:fs';
import path from 'node:path';
import { readModModules, type ModInspection } from './mods';

export interface PluginBase {
  name: string;
  path: string;
  source?: string;
}

export type PluginScope = 'user' | 'project' | 'local' | 'builtin' | 'unknown';

/** The CLI's `path` for a plugin built into Claude Code (2.1.288 init). */
export const BUILTIN_PLUGIN_PATH = 'builtin';

export interface PluginMod {
  /** The hooks modules hooks.json names. */
  modules: string[];
  /** What `claude plugin validate` says it does; null until inspected, or
   *  when validate could not read it. */
  inspection: ModInspection | null;
}

export interface EnrichedPlugin extends PluginBase {
  scope: PluginScope;
  version?: string;
  description?: string;
  author?: string;
  authorEmail?: string;
  /** Non-null when the plugin holds mod code. */
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

/** One install of a plugin, as the CLI records it. */
interface InstallRecordEntry {
  scope?: string;
  projectPath?: string;
}

/** `name@marketplace` → every scope that id is installed under. */
export type InstalledPlugins = Map<string, InstallRecordEntry[]>;

/**
 * The CLI's own record of what is installed where:
 * `<config>/plugins/installed_plugins.json`, `{ version: 2, plugins: { id: [entry] } }`.
 * A missing or unreadable file is an empty record — the folder guess still
 * answers — never an error that would empty the plugin list.
 */
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

/**
 * The scope the CLI recorded for `id`, as this session sees it. One plugin
 * can be installed user-wide and for particular projects at once; an install
 * for this session's project is the more specific answer, so it wins. Null
 * when the record does not list the id, or lists only a scope OmniFex has no
 * group for — the caller then falls back to the folder guess.
 */
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

/**
 * Characters that are invisible or reorder what follows them.
 *
 *  • C0/C1 controls and DEL, minus the whitespace handled below. This is what
 *    strips the ESC out of an ANSI sequence.
 *  • U+200B-200F zero-width space/non-joiner/joiner and the LTR/RTL marks.
 *  • U+202A-202E and U+2066-2069 — bidi embeddings, overrides and isolates.
 *    U+202E is the "gpj.exe renders as exe.jpg" trick.
 *  • U+2060-2064 word joiner and invisible operators, U+00AD soft hyphen,
 *    U+180E Mongolian vowel separator, U+FEFF BOM.
 */
// eslint-disable-next-line no-control-regex -- deliberate: stripping control characters is the point.
const INVISIBLE_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Make manifest-supplied text safe to render.
 *
 * A plugin's `.claude-plugin/plugin.json` is written by whoever published the
 * plugin, and OmniFex reads it directly rather than through the CLI — so the
 * CLI's own marketplace hardening (2.1.247 rejects names with control or
 * invisible characters and escapes marketplace text in `/plugin` output) does
 * not cover the fields we surface ourselves.
 *
 * This is not an injection defence: React escapes markup, so the exposure is
 * spoofing — a name that renders as a different name, or a description that
 * reorders the row around it. Strip rather than reject, so a plugin with a
 * sloppy manifest still lists.
 *
 * Tab/newline/CR become a space instead of vanishing: dropping them outright
 * would turn "first\nsecond" into "firstsecond", silently merging words.
 * Returns undefined for absent input and for text that sanitizes to nothing,
 * so a hostile field reads as missing rather than as a blank row.
 */
/** Stand-in for a name that sanitizes to nothing. Same wording the CLI uses
 *  for an unprintable marketplace plugin name. */
const UNPRINTABLE_NAME = '(unprintable plugin name)';

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
    /** The CLI's install record, read once per list by the caller. */
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
  // `path` is deliberately NOT sanitized: it is a real filesystem path used to
  // read the manifest and to key the renderer's list, not prose. Altering it
  // would break the lookup it participates in. `name` and `source` come from
  // the CLI rather than the manifest, but the CLI only hardens marketplace
  // names — a locally installed plugin's name reaches us unchecked.
  return {
    ...plugin,
    name: sanitizeManifestText(plugin.name) ?? UNPRINTABLE_NAME,
    source: sanitizeManifestText(plugin.source),
    // The CLI's record first; the folder guess covers what it does not list
    // (built-ins, --plugin-dir folders, a missing record).
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
