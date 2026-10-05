// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { SlashCommand } from '@/lib/api';

// Stub framer-motion so motion.* renders as a plain element. The picker only
// uses motion.div, but proxy every key for safety.
//
// The component per tag is CACHED. A proxy that builds a fresh function on
// every `get` hands React a new component TYPE on every render, which
// unmounts and remounts the subtree and wipes its state — here, the picker's
// selected index, so Enter selected nothing and `onSelect` never fired. It
// presented as a flake because it only bites when a re-render lands between
// the `waitFor` and the keypress.
const motionComponents = new Map<string, any>();
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_, key) => {
        const Tag = key as string;
        const cached = motionComponents.get(Tag);
        if (cached) return cached;
        const Component = ({ children, ...rest }: any) => {
          const { initial, animate, exit, transition, layout, ...domProps } = rest;
          void initial; void animate; void exit; void transition; void layout;

          // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory hoisted before module imports settle.
          return require('react').createElement(Tag, domProps, children);
        };
        motionComponents.set(Tag, Component);
        return Component;
      },
    },
  ),
  AnimatePresence: ({ children }: any) => children,
}));

const slashCommandsListMock = vi.fn();
const sessionSupportedCommandsMock = vi.fn();
const listSupportedCommandsMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    slashCommandsList: (...args: any[]) => slashCommandsListMock(...args),
    sessionSupportedCommands: (...args: any[]) => sessionSupportedCommandsMock(...args),
    listSupportedCommands: (...args: any[]) => listSupportedCommandsMock(...args),
  },
}));

// Imported after the mock so the component picks up the stubbed api.
import { SlashCommandPicker } from '../SlashCommandPicker';

const makeCmd = (over: Partial<SlashCommand>): SlashCommand => ({
  id: over.id ?? over.full_command ?? 'x',
  name: over.name ?? 'x',
  full_command: over.full_command ?? '/x',
  namespace: '',
  scope: over.scope ?? 'project',
  content: '',
  description: over.description ?? '',
  allowed_tools: [],
  file_path: '',
  has_bash_commands: false,
  has_file_references: false,
  accepts_arguments: false,
  ...over,
});

const projectCmd = makeCmd({ id: 'p1', name: 'projonly', full_command: '/projonly', scope: 'project', description: 'project-only command' });
const userCmd = makeCmd({ id: 'u1', name: 'useronly', full_command: '/useronly', scope: 'user', description: 'user-only command' });
const sdkCommands = [
  { name: 'help', description: 'built-in help' },
  { name: 'clear', description: 'clear conversation' },
];

const baseProps = {
  tabId: 'tab-1',
  onSelect: vi.fn(),
  onClose: vi.fn(),
};

beforeEach(() => {
  slashCommandsListMock.mockReset();
  sessionSupportedCommandsMock.mockReset();
  listSupportedCommandsMock.mockReset();
  slashCommandsListMock.mockResolvedValue([projectCmd, userCmd]);
  sessionSupportedCommandsMock.mockResolvedValue(sdkCommands);
  listSupportedCommandsMock.mockResolvedValue([]);
  // jsdom doesn't implement scrollIntoView; the picker's selection effect uses it.
  if (!('scrollIntoView' in Element.prototype)) {
    (Element.prototype as any).scrollIntoView = () => {};
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPicker = (props: Partial<typeof baseProps> & { configDir?: string } = {}) =>
  render(<SlashCommandPicker {...baseProps} {...props} />);

const getFilterButton = (label: string) =>
  screen.getByRole('button', { name: label });

const tabLabels = () =>
  Array.from(getFilterButton('All').parentElement!.querySelectorAll('button')).map(b => b.textContent);

const notNull = (v: unknown) => { expect(v).not.toBeNull(); };
const isNull = (v: unknown) => { expect(v).toBeNull(); };

describe('SlashCommandPicker filter tabs', () => {
  it('labels the CLI-sourced filter as "Claude" (not "Default")', async () => {
    renderPicker();
    await waitFor(() => { expect(slashCommandsListMock).toHaveBeenCalled(); });
    isNull(screen.queryByRole('button', { name: 'Default' }));
    notNull(screen.queryByRole('button', { name: 'Claude' }));
  });

  it('renders a tab per type present, in order All · Project · User · OmniFex · Claude', async () => {
    renderPicker();
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    expect(tabLabels()).toEqual(['All', 'Project', 'User', 'OmniFex', 'Claude']);
  });

  it('selects the All tab on open', async () => {
    renderPicker();
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    // "All" is the default selection — every scope should be visible.
    notNull(screen.queryByText('/projonly'));
    notNull(screen.queryByText('/useronly'));
    notNull(screen.queryByText('/help'));
  });

  it('User tab shows only user-scoped commands', async () => {
    renderPicker();
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    fireEvent.click(getFilterButton('User'));
    notNull(screen.queryByText('/useronly'));
    isNull(screen.queryByText('/projonly'));
    isNull(screen.queryByText('/help'));
  });

  it('surfaces a fresh CLI command from the config-dir catalog that the session snapshot lacks', async () => {
    // The stale session snapshot is missing /design-sync; the fresh catalog
    // (keyed by configDir) has it. The picker must union both so it appears.
    listSupportedCommandsMock.mockResolvedValue([
      { name: 'design-sync', description: 'Sync design tokens' },
    ]);
    renderPicker({ configDir: '/Users/me/.claude-personal' });
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    // Default tab is "All" — the freshly-catalogued command shows up.
    notNull(screen.queryByText('/design-sync'));
    // And it doesn't crash the existing session/custom commands.
    notNull(screen.queryByText('/help'));
    notNull(screen.queryByText('/projonly'));
  });

  it('does not fetch the config-dir catalog when no configDir is provided', async () => {
    renderPicker(); // baseProps has no configDir
    await waitFor(() => { expect(sessionSupportedCommandsMock).toHaveBeenCalled(); });
    expect(listSupportedCommandsMock).not.toHaveBeenCalled();
  });

  it('Claude tab shows only CLI (default-scope) commands', async () => {
    renderPicker();
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    fireEvent.click(getFilterButton('Claude'));
    notNull(screen.queryByText('/help'));
    notNull(screen.queryByText('/clear'));
    isNull(screen.queryByText('/projonly'));
    isNull(screen.queryByText('/useronly'));
  });

  it('ArrowRight cycles to the next tab (All → Project)', async () => {
    renderPicker();
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    notNull(screen.queryByText('/projonly'));
    isNull(screen.queryByText('/useronly'));
    isNull(screen.queryByText('/help'));
  });

  it('ArrowLeft wraps from All to Claude', async () => {
    renderPicker();
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    // "Claude" (last tab) shows only the CLI default-scope commands.
    notNull(screen.queryByText('/help'));
    notNull(screen.queryByText('/clear'));
    isNull(screen.queryByText('/projonly'));
    isNull(screen.queryByText('/useronly'));
  });

  it('ArrowRight from the last tab (Claude) wraps back to All', async () => {
    renderPicker();
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    // All → Project → User → OmniFex → Claude → All
    for (let i = 0; i < 5; i++) fireEvent.keyDown(window, { key: 'ArrowRight' });
    notNull(screen.queryByText('/projonly'));
    notNull(screen.queryByText('/useronly'));
    notNull(screen.queryByText('/help'));
  });

  it('only fires onSelect once when Enter is pressed twice in a row', async () => {
    // Repro for the bug where the picker, kept mounted briefly by AnimatePresence's
    // exit animation, would re-fire onSelect on the next Enter — after the parent
    // had already moved on to "send". This caused the typed command to repopulate
    // the textarea after the first send, requiring a second Enter to finally clear.
    const onSelect = vi.fn();
    renderPicker({ onSelect });
    await waitFor(() => { notNull(screen.queryByText('/projonly')); });
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('still navigates command list with ArrowUp/ArrowDown (does not regress)', async () => {
    // Two project commands so up/down has somewhere to go.
    const projectCmd2 = makeCmd({ id: 'p2', name: 'projonly2', full_command: '/projonly2', scope: 'project' });
    slashCommandsListMock.mockResolvedValue([projectCmd, projectCmd2]);
    renderPicker();
    await waitFor(() => { notNull(screen.queryByText('/projonly')); });
    // Narrow to the Project tab so only the two project commands are listed
    // (the default "All" tab would interleave the CLI commands).
    fireEvent.click(getFilterButton('Project'));
    // Selected row gets the .bg-accent class; the first row should be selected on load.
    const rowOne = screen.getByText('/projonly').closest('tr')!;
    const rowTwo = screen.getByText('/projonly2').closest('tr')!;
    expect(rowOne.className).toMatch(/bg-accent/);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(rowTwo.className).toMatch(/bg-accent/);
  });
});

const allRows = () =>
  Array.from(document.querySelectorAll('tbody tr[data-index] td:first-child')).map(td => td.textContent);
// OmniFex's own commands (/status with a session) are left out of the
// column-sort expectations; their default place is asserted on its own.
const commandOrder = () => allRows().filter(name => name !== '/status');

describe('SlashCommandPicker ordering and sorting', () => {
  const projZ = makeCmd({ id: 'pz', name: 'zeta', full_command: '/zeta', scope: 'project', description: 'b' });
  const userA = makeCmd({ id: 'ua', name: 'alpha', full_command: '/alpha', scope: 'user', description: 'c' });

  beforeEach(() => {
    slashCommandsListMock.mockResolvedValue([userA, projZ]);
    sessionSupportedCommandsMock.mockResolvedValue([{ name: 'aaa', description: 'a' }]);
  });

  it('lists Project, then User, then OmniFex, then Claude by default, names alphabetical within each', async () => {
    renderPicker();
    await waitFor(() => { notNull(screen.queryByText('/zeta')); });
    expect(allRows()).toEqual(['/zeta', '/alpha', '/status', '/aaa']);
  });

  it('keeps that scope order while filtering', async () => {
    renderPicker({ initialQuery: 'a' } as never);
    await waitFor(() => { notNull(screen.queryByText('/zeta')); });
    expect(commandOrder()).toEqual(['/zeta', '/alpha', '/aaa']);
  });

  it('sorts by a column ascending, then descending, then back to the default', async () => {
    renderPicker();
    await waitFor(() => { notNull(screen.queryByText('/zeta')); });
    const header = screen.getByRole('button', { name: /^Command/ });
    fireEvent.click(header);
    expect(commandOrder()).toEqual(['/aaa', '/alpha', '/zeta']);
    fireEvent.click(header);
    expect(commandOrder()).toEqual(['/zeta', '/alpha', '/aaa']);
    fireEvent.click(screen.getByRole('button', { name: /^Description/ }));
    expect(commandOrder()).toEqual(['/aaa', '/zeta', '/alpha']);
    fireEvent.click(screen.getByRole('button', { name: /^Type/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Type/ }));
    expect(commandOrder()).toEqual(['/aaa', '/alpha', '/zeta']);
    fireEvent.click(screen.getByRole('button', { name: /^Type/ }));
    expect(commandOrder()).toEqual(['/zeta', '/alpha', '/aaa']);
  });

  it('shows the whole description and lets the column width truncate it', async () => {
    const long = 'x'.repeat(200);
    slashCommandsListMock.mockResolvedValue([makeCmd({ id: 'l', name: 'long', full_command: '/long', description: long })]);
    renderPicker();
    await waitFor(() => { notNull(screen.queryByText('/long')); });
    expect(screen.getByText(long)).toBeTruthy();
  });
});

describe('SlashCommandPicker command types', () => {
  beforeEach(() => {
    sessionSupportedCommandsMock.mockResolvedValue([
      { name: 'compact', description: 'built-in' },
      { name: 'superpowers:brainstorming', description: 'from a plugin' },
      { name: 'mcp__github__list_prs', description: 'an MCP prompt' },
    ]);
  });

  it('splits plugin commands and MCP prompts out of Claude, each with a tab and badge', async () => {
    renderPicker();
    await waitFor(() => { notNull(screen.queryByText('/compact')); });
    expect(tabLabels()).toEqual(['All', 'Project', 'User', 'Plugin', 'MCP', 'OmniFex', 'Claude']);
    const badge = (cmd: string) => screen.getByText(cmd).closest('tr')!.querySelectorAll('td')[1].textContent;
    expect(badge('/superpowers:brainstorming')).toBe('plugin');
    expect(badge('/mcp__github__list_prs')).toBe('mcp');
    expect(badge('/compact')).toBe('claude');
    expect(badge('/status')).toBe('omnifex');
  });

  it('Plugin tab shows only plugin commands', async () => {
    renderPicker();
    await waitFor(() => { notNull(screen.queryByText('/compact')); });
    fireEvent.click(getFilterButton('Plugin'));
    notNull(screen.queryByText('/superpowers:brainstorming'));
    isNull(screen.queryByText('/compact'));
    isNull(screen.queryByText('/mcp__github__list_prs'));
  });

  it('orders All as Project, User, Plugin, MCP, OmniFex, Claude', async () => {
    renderPicker();
    await waitFor(() => { notNull(screen.queryByText('/compact')); });
    expect(allRows()).toEqual([
      '/projonly', '/useronly', '/superpowers:brainstorming', '/mcp__github__list_prs', '/status', '/compact',
    ]);
  });

  it('leaves out tabs for types with no commands', async () => {
    sessionSupportedCommandsMock.mockResolvedValue([{ name: 'compact', description: 'built-in' }]);
    renderPicker({ tabId: undefined } as never);
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    expect(tabLabels()).toEqual(['All', 'Project', 'User']);
  });
});
