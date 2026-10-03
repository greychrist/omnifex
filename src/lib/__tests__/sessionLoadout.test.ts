import { describe, it, expect } from 'vitest';
import { classifyJsonlLine } from '@/lib/jsonlClassifier';
import type { JsonlNode } from '@/types/jsonl';
import type { SessionPluginInfo } from '@/lib/api';
import { modStatusLines, latestInitMcpCount, loadoutSummary, splitPlugins } from '@/lib/sessionLoadout';

const node = (raw: Record<string, unknown>): JsonlNode =>
  classifyJsonlLine({ receivedAt: '2026-10-03T10:00:00Z', ...raw })!;

const status = (plugin: string, text: string | null) => node({ type: 'system', subtype: 'ui_status', plugin, text });

const plugin = (name: string, extra: Partial<SessionPluginInfo> = {}): SessionPluginInfo => ({
  name, path: `/p/${name}`, scope: 'user', mod: null, ...extra,
});
const mod = (name: string): SessionPluginInfo =>
  plugin(name, { mod: { modules: ['./r.js'], inspection: null } });

describe('modStatusLines', () => {
  // $.ui.status pins one line per plugin, each call replacing the last.
  it('keeps the latest line per plugin', () => {
    const lines = modStatusLines([status('a', 'one'), status('b', 'bee'), status('a', 'two')]);
    expect(lines).toEqual({ a: 'two', b: 'bee' });
  });

  it('drops a plugin whose latest call cleared its line', () => {
    expect(modStatusLines([status('a', 'one'), status('a', null)])).toEqual({});
  });

  it('ignores everything else', () => {
    expect(modStatusLines([node({ type: 'system', subtype: 'ui_log', plugin: 'a', text: 'x' })])).toEqual({});
  });
});

describe('latestInitMcpCount', () => {
  it('counts the MCP servers on the latest init', () => {
    const init = (n: number) => node({ type: 'system', subtype: 'init', session_id: 's', mcp_servers: Array.from({ length: n }, (_, i) => ({ name: `m${i}`, status: 'connected' })) });
    expect(latestInitMcpCount([init(3), init(2)])).toBe(2);
  });

  it('is null before any init', () => {
    expect(latestInitMcpCount([])).toBeNull();
  });
});

describe('splitPlugins', () => {
  // A mod is listed once, under Mods, not again under Plugins.
  it('separates mods from plugins', () => {
    const { mods, plugins } = splitPlugins([plugin('a'), mod('m'), plugin('b')]);
    expect(mods.map((p) => p.name)).toEqual(['m']);
    expect(plugins.map((p) => p.name)).toEqual(['a', 'b']);
  });
});

describe('loadoutSummary', () => {
  it('reads as counts, singular where one', () => {
    expect(loadoutSummary({ mods: 1, plugins: 14, mcp: 2 })).toBe('1 mod · 14 plugins · 2 MCP servers');
    expect(loadoutSummary({ mods: 0, plugins: 1, mcp: 1 })).toBe('1 plugin · 1 MCP server');
  });

  // A count we do not have yet is left out, not shown as zero.
  it('omits what is unknown and says nothing when everything is', () => {
    expect(loadoutSummary({ mods: null, plugins: null, mcp: 3 })).toBe('3 MCP servers');
    expect(loadoutSummary({ mods: null, plugins: null, mcp: null })).toBeNull();
  });
});
