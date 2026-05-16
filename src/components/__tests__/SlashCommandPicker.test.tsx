// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { SlashCommand } from '@/lib/api';

// Stub framer-motion so motion.* renders as a plain element. The picker only
// uses motion.div, but proxy every key for safety.
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_, key) => {
        const Tag = key as string;
        return ({ children, ...rest }: any) => {
          const { initial, animate, exit, transition, layout, ...domProps } = rest;
          void initial; void animate; void exit; void transition; void layout;

          // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory hoisted before module imports settle.
          return require('react').createElement(Tag, domProps, children);
        };
      },
    },
  ),
  AnimatePresence: ({ children }: any) => children,
}));

const slashCommandsListMock = vi.fn();
const sessionSupportedCommandsMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    slashCommandsList: (...args: any[]) => slashCommandsListMock(...args),
    sessionSupportedCommands: (...args: any[]) => sessionSupportedCommandsMock(...args),
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
  slashCommandsListMock.mockResolvedValue([projectCmd, userCmd]);
  sessionSupportedCommandsMock.mockResolvedValue(sdkCommands);
  // jsdom doesn't implement scrollIntoView; the picker's selection effect uses it.
  if (!('scrollIntoView' in Element.prototype)) {
    (Element.prototype as any).scrollIntoView = () => {};
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPicker = (props: Partial<typeof baseProps> = {}) =>
  render(<SlashCommandPicker {...baseProps} {...props} />);

const getFilterButton = (label: string) =>
  screen.getByRole('button', { name: label });

const notNull = (v: unknown) => { expect(v).not.toBeNull(); };
const isNull = (v: unknown) => { expect(v).toBeNull(); };

describe('SlashCommandPicker filter tabs', () => {
  it('labels the SDK-sourced filter as "Claude" (not "Default")', async () => {
    renderPicker();
    await waitFor(() => { expect(slashCommandsListMock).toHaveBeenCalled(); });
    isNull(screen.queryByRole('button', { name: 'Default' }));
    notNull(screen.queryByRole('button', { name: 'Claude' }));
  });

  it('renders tabs in order Project · User · Claude · All', async () => {
    renderPicker();
    await waitFor(() => { expect(slashCommandsListMock).toHaveBeenCalled(); });
    const tabBar = getFilterButton('Project').parentElement!;
    const labels = Array.from(tabBar.querySelectorAll('button')).map(b => b.textContent);
    expect(labels).toEqual(['Project', 'User', 'Claude', 'All']);
  });

  it('selects the Project tab on open', async () => {
    renderPicker();
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    // Only the project-scoped command should be visible; user + SDK are filtered out.
    notNull(screen.queryByText('/projonly'));
    isNull(screen.queryByText('/useronly'));
    isNull(screen.queryByText('/help'));
  });

  it('User tab shows only user-scoped commands', async () => {
    renderPicker();
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    fireEvent.click(getFilterButton('User'));
    notNull(screen.queryByText('/useronly'));
    isNull(screen.queryByText('/projonly'));
    isNull(screen.queryByText('/help'));
  });

  it('Claude tab shows only SDK (default-scope) commands', async () => {
    renderPicker();
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    fireEvent.click(getFilterButton('Claude'));
    notNull(screen.queryByText('/help'));
    notNull(screen.queryByText('/clear'));
    isNull(screen.queryByText('/projonly'));
    isNull(screen.queryByText('/useronly'));
  });

  it('ArrowRight cycles to the next tab (Project → User)', async () => {
    renderPicker();
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    notNull(screen.queryByText('/useronly'));
    isNull(screen.queryByText('/projonly'));
  });

  it('ArrowLeft wraps from Project to All', async () => {
    renderPicker();
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    // "All" shows everything
    notNull(screen.queryByText('/projonly'));
    notNull(screen.queryByText('/useronly'));
    notNull(screen.queryByText('/help'));
  });

  it('ArrowRight from the last tab (All) wraps back to Project', async () => {
    renderPicker();
    await waitFor(() => { isNull(screen.queryByText(/Loading commands/)); });
    // Project → User → Claude → All → Project
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    notNull(screen.queryByText('/projonly'));
    isNull(screen.queryByText('/useronly'));
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
    // Selected row gets the .bg-accent class; the first row should be selected on load.
    const rowOne = screen.getByText('/projonly').closest('tr')!;
    const rowTwo = screen.getByText('/projonly2').closest('tr')!;
    expect(rowOne.className).toMatch(/bg-accent/);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(rowTwo.className).toMatch(/bg-accent/);
  });
});
