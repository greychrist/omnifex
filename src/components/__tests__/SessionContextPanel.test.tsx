// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import { SessionContextPanel } from '@/components/SessionContextPanel';
import type { SessionPluginInfo } from '@/lib/api';

afterEach(() => { cleanup(); localStorage.clear(); });

const plugin = (name: string, extra: Partial<SessionPluginInfo> = {}): SessionPluginInfo => ({
  name, path: `/p/${name}`, scope: 'user', mod: null, ...extra,
});

const guard = plugin('blast-radius', {
  version: '1.0.0',
  mod: {
    modules: ['./register.ts'],
    inspection: { hooks: ['tool.call{tool=Bash}', 'ui.render{component=Pane}'], calls: ['process.run'], capabilities: ['tool-calls', 'processes'] },
  },
});
const unread = plugin('mystery', { mod: { modules: ['./r.js'], inspection: null } });

function renderPanel(props: Partial<React.ComponentProps<typeof SessionContextPanel>> = {}) {
  return render(
    <SessionContextPanel
      plugins={[guard, unread, plugin('superpowers'), plugin('cc-plugin-agents-md', { path: 'builtin', scope: 'builtin' })]}
      onRefreshPlugins={vi.fn()}
      modStatus={{}}
      mcpCount={2}
      mcp={<div data-testid="mcp-body" />}
      instructions={<div data-testid="instructions-body" />}
      {...props}
    />,
  );
}

const section = (name: RegExp) => screen.getByRole('region', { name });
// Every section starts collapsed; the headers and counts are the overview.
const openSection = (name: RegExp) => { fireEvent.click(screen.getByRole('button', { name })); };
const openPlugins = () => { openSection(/^Plugins/); };
const openMods = () => { openSection(/^Mods/); };

describe('SessionContextPanel', () => {
  it('holds mods, plugins, MCP servers and instructions as sections, with counts', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /^Mods\s*2$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Plugins\s*2$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^MCP servers\s*2$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Instructions$/ })).toBeTruthy();
  });

  it('lists each mod once, under Mods, and not again under Plugins', () => {
    renderPanel();
    openPlugins();
    openMods();
    expect(within(section(/^Mods/)).getByText('blast-radius')).toBeTruthy();
    expect(within(section(/^Plugins/)).queryByText('blast-radius')).toBeNull();
    expect(within(section(/^Plugins/)).getByText('superpowers')).toBeTruthy();
  });

  // The capability that reaches past OmniFex's permission prompt is the
  // reason this section exists.
  it('says what each mod can do', () => {
    renderPanel();
    openMods();
    const mods = section(/^Mods/);
    expect(within(mods).getByText('Approves or blocks tool calls')).toBeTruthy();
    expect(within(mods).getByText('Runs processes')).toBeTruthy();
  });

  it('says so when it could not read what a mod does, rather than implying nothing', () => {
    renderPanel();
    openMods();
    expect(within(section(/^Mods/)).getByText(/could not read what this mod does/i)).toBeTruthy();
  });

  it("shows a mod's pinned status line", () => {
    renderPanel({ modStatus: { 'blast-radius': 'Holding: rm -rf build/' } });
    openMods();
    expect(within(section(/^Mods/)).getByText('Holding: rm -rf build/')).toBeTruthy();
  });

  it('opens a mod to list the events it hooks and the calls it makes', () => {
    renderPanel();
    openMods();
    fireEvent.click(within(section(/^Mods/)).getByRole('button', { name: /blast-radius/ }));
    expect(screen.getByText('tool.call{tool=Bash}')).toBeTruthy();
    expect(screen.getByText('process.run')).toBeTruthy();
  });

  it('says when no mods are loaded', () => {
    renderPanel({ plugins: [plugin('superpowers')] });
    openMods();
    expect(within(section(/^Mods/)).getByText(/no mods loaded/i)).toBeTruthy();
  });

  it('starts with every section collapsed', () => {
    renderPanel();
    for (const name of [/^Mods/, /^Plugins/, /^MCP servers/, /^Instructions/]) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-expanded')).toBe('false');
    }
    expect(screen.queryByTestId('mcp-body')).toBeNull();
    expect(screen.queryByTestId('instructions-body')).toBeNull();
  });

  it('groups built-in plugins on their own', () => {
    renderPanel();
    openPlugins();
    expect(within(section(/^Plugins/)).getByText(/built in/i)).toBeTruthy();
  });

  it('shows a loading state while the plugin list is unknown, not "none"', () => {
    renderPanel({ plugins: null });
    expect(screen.queryByText(/no mods loaded/i)).toBeNull();
    expect(screen.getByRole('button', { name: /^Mods$/ })).toBeTruthy();
  });

  it('opens and collapses a section, and remembers it', () => {
    renderPanel();
    openSection(/^MCP servers/);
    expect(screen.getByTestId('mcp-body')).toBeTruthy();
    cleanup();
    renderPanel();
    expect(screen.getByTestId('mcp-body')).toBeTruthy();
    openSection(/^MCP servers/);
    expect(screen.queryByTestId('mcp-body')).toBeNull();
    cleanup();
    renderPanel();
    expect(screen.queryByTestId('mcp-body')).toBeNull();
  });

  it('reloads plugins on request', () => {
    const onRefreshPlugins = vi.fn();
    renderPanel({ onRefreshPlugins });
    fireEvent.click(screen.getByRole('button', { name: /reload plugins/i }));
    expect(onRefreshPlugins).toHaveBeenCalledTimes(1);
  });
});
