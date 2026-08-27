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
    readFile?: (p: string) => string;
  } = {},
): EnrichedPlugin {
  const manifest = readPluginManifest(plugin.path, options.readFile);
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
    scope: inferScope(plugin.path, options),
    version: sanitizeManifestText(manifest?.version),
    description: sanitizeManifestText(manifest?.description),
    author: sanitizeManifestText(author.name),
    authorEmail: sanitizeManifestText(author.email),
  };
}
