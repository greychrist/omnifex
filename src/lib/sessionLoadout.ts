/**
 * What is loaded into a session — mods, plugins, MCP servers — as the
 * Session context panel and the context popover's summary row read it.
 *
 * Pure: everything comes from the session's messages (system:init, a mod's
 * ui_status frames) or the plugin list main returns.
 */
import type { JsonlNode } from '@/types/jsonl';
import type { SessionPluginInfo } from '@/lib/api';

/**
 * Each mod's current pinned status line (`$.ui.status`), by plugin name.
 * Every call replaces that plugin's previous line; `text: null` clears it.
 */
export function modStatusLines(messages: JsonlNode[]): Record<string, string> {
  const lines = new Map<string, string>();
  for (const m of messages) {
    if (m.kind !== 'system' || m.subtype !== 'ui_status') continue;
    const { plugin, text } = m.raw as unknown as { plugin?: unknown; text?: unknown };
    if (typeof plugin !== 'string') continue;
    if (typeof text === 'string' && text) lines.set(plugin, text);
    else lines.delete(plugin);
  }
  return Object.fromEntries(lines);
}

/** MCP servers on the latest system:init; null before the first one. */
export function latestInitMcpCount(messages: JsonlNode[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const node = messages[i];
    if (node.kind !== 'cli-stream-init') continue;
    const servers = (node.raw as { mcp_servers?: unknown }).mcp_servers;
    return Array.isArray(servers) ? servers.length : 0;
  }
  return null;
}

/** Mods are listed once, in their own section, not again among plugins. */
export function splitPlugins(all: SessionPluginInfo[]): { mods: SessionPluginInfo[]; plugins: SessionPluginInfo[] } {
  return {
    mods: all.filter((p) => p.mod !== null),
    plugins: all.filter((p) => p.mod === null),
  };
}

export interface LoadoutCounts {
  mods: number | null;
  plugins: number | null;
  mcp: number | null;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** `1 mod · 14 plugins · 2 MCP servers`. Unknown and zero counts are left
 *  out; null when nothing is left to say. */
export function loadoutSummary(c: LoadoutCounts): string | null {
  const parts: string[] = [];
  if (c.mods) parts.push(count(c.mods, 'mod', 'mods'));
  if (c.plugins) parts.push(count(c.plugins, 'plugin', 'plugins'));
  if (c.mcp) parts.push(count(c.mcp, 'MCP server', 'MCP servers'));
  return parts.length > 0 ? parts.join(' · ') : null;
}
