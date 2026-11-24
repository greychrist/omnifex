// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import type { HooksConfiguration } from '@/types/hooks';

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: (_, key) => {
      const Tag = key as string;
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory hoisted before module imports settle.
      const React = require('react');
      return React.forwardRef(({ children, ...rest }: any, ref: unknown) => {
        const { initial: _initial, animate: _animate, exit: _exit, transition: _transition, layout: _layout, whileTap: _whileTap, ...domProps } = rest;
        return React.createElement(Tag, { ...domProps, ref }, children);
      });
    },
  }),
  AnimatePresence: ({ children }: any) => children,
}));

// Radix Select relies on pointer-capture APIs jsdom lacks, so its dropdown
// never opens under fireEvent.
vi.mock('@/components/ui/select', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory hoisted before module imports settle.
  const React = require('react');
  const Ctx = React.createContext({});
  return {
    Select: ({ children, onValueChange }: any) =>
      React.createElement(Ctx.Provider, { value: { onValueChange } }, React.createElement('div', null, children)),
    SelectTrigger: ({ children, id }: any) =>
      React.createElement('button', { id, type: 'button' }, children),
    SelectValue: () => null,
    SelectContent: ({ children }: any) => React.createElement('div', null, children),
    SelectItem: ({ children, value }: any) => {
      const ctx = React.useContext(Ctx);
      return React.createElement(
        'button',
        { type: 'button', 'data-testid': `select-item-${value}`, onClick: () => ctx.onValueChange?.(value) },
        children,
      );
    },
  };
});

const getHooksConfig = vi.fn<() => Promise<HooksConfiguration>>();
const updateHooksConfig = vi.fn<() => Promise<void>>();

vi.mock('@/lib/api', () => ({
  api: {
    getHooksConfig: () => getHooksConfig(),
    updateHooksConfig: (...args: unknown[]) => {
      lastSaved = args[1] as HooksConfiguration;
      return updateHooksConfig();
    },
  },
}));

let lastSaved: HooksConfiguration | null = null;

import { HooksEditor } from '@/components/HooksEditor';

// The real on-disk shape of a Stop hook: nested under `hooks`.
const REAL_CONFIG: HooksConfiguration = {
  Stop: [
    {
      matcher: '',
      hooks: [{ type: 'command', command: '/Users/me/.claude/hooks/check-unfinished-todos.py' }],
    },
  ],
};

beforeEach(() => {
  getHooksConfig.mockReset().mockResolvedValue({});
  updateHooksConfig.mockReset().mockResolvedValue(undefined);
  lastSaved = null;
});
afterEach(() => { cleanup(); });

const renderEditor = () =>
  render(<HooksEditor scope="user" configDir="/cfg" projectPath="/repo" />);

describe('HooksEditor — nested shape (the Stop-hook regression)', () => {
  it('renders the command of a real nested Stop hook', async () => {
    getHooksConfig.mockResolvedValue(REAL_CONFIG);
    renderEditor();

    // Switch to the Stop event — the editor opens on PreToolUse.
    fireEvent.click(await screen.findByTestId('select-item-Stop'));

    const textarea = await screen.findByDisplayValue(
      '/Users/me/.claude/hooks/check-unfinished-todos.py',
    );
    expect(textarea).toBeInTheDocument();
  });

  it('saves an edited Stop hook back in the NESTED shape', async () => {
    // The CLI never executes a Stop hook stripped of its `hooks` nesting.
    getHooksConfig.mockResolvedValue(REAL_CONFIG);
    renderEditor();

    fireEvent.click(await screen.findByTestId('select-item-Stop'));
    fireEvent.change(
      await screen.findByDisplayValue('/Users/me/.claude/hooks/check-unfinished-todos.py'),
      { target: { value: '/Users/me/.claude/hooks/edited.py' } },
    );
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => { expect(lastSaved).not.toBeNull(); });
    expect(lastSaved).toEqual({
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: '/Users/me/.claude/hooks/edited.py' }] },
      ],
    });
  });
});

describe('HooksEditor — event coverage', () => {
  it('offers events the old five-tab editor never had', async () => {
    renderEditor();
    await screen.findByTestId('select-item-Stop');

    for (const label of ['Session Start', 'Prompt Submit', 'Pre Compact', 'File Changed']) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  it('groups the picker by lifecycle area', async () => {
    renderEditor();
    await screen.findByTestId('select-item-Stop');
    expect(await screen.findByText('Permissions')).toBeInTheDocument();
    expect(await screen.findByText('Subagents & Tasks')).toBeInTheDocument();
  });

  it('offers a matcher field with per-event examples for matcher events', async () => {
    renderEditor();
    fireEvent.click(await screen.findByTestId('select-item-SessionStart'));
    fireEvent.click(screen.getByRole('button', { name: /add hook/i }));

    expect(await screen.findByLabelText('How the session started')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/startup, resume, clear/),
    ).toBeInTheDocument();
  });

  it('offers NO matcher field for an always-fire event', async () => {
    // The CLI silently ignores `matcher` on Stop.
    renderEditor();
    fireEvent.click(await screen.findByTestId('select-item-Stop'));
    fireEvent.click(screen.getByRole('button', { name: /add hook/i }));

    expect(await screen.findByText(/always fires — no matcher/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Tool name/)).toBeNull();
  });

  it('writes a new hook in the nested shape', async () => {
    renderEditor();
    fireEvent.click(await screen.findByTestId('select-item-SessionStart'));
    fireEvent.click(screen.getByRole('button', { name: /add hook/i }));
    fireEvent.click(screen.getByRole('button', { name: /add command/i }));
    fireEvent.change(screen.getByPlaceholderText('Enter shell command...'), {
      target: { value: 'echo started' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => { expect(lastSaved).not.toBeNull(); });
    expect(lastSaved).toEqual({
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo started' }] }],
    });
  });
});

describe('HooksEditor — onFailure (CLI 2.1.295)', () => {
  const addSessionStartCommand = async () => {
    fireEvent.click(await screen.findByTestId('select-item-SessionStart'));
    fireEvent.click(screen.getByRole('button', { name: /add hook/i }));
    fireEvent.click(screen.getByRole('button', { name: /add command/i }));
    fireEvent.change(screen.getByPlaceholderText('Enter shell command...'), {
      target: { value: 'echo started' },
    });
  };

  it('writes onFailure:"block" when the switch is on', async () => {
    renderEditor();
    await addSessionStartCommand();
    fireEvent.click(screen.getByRole('switch', { name: /block on failure/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => { expect(lastSaved).not.toBeNull(); });
    expect(lastSaved).toEqual({
      SessionStart: [
        { matcher: '', hooks: [{ type: 'command', command: 'echo started', onFailure: 'block' }] },
      ],
    });
  });

  it('omits the key when switched back off — "continue" is the CLI default', async () => {
    renderEditor();
    await addSessionStartCommand();
    // Re-query between clicks: the framer-motion mock remounts the subtree on
    // every render.
    const toggle = () => screen.getByRole('switch', { name: /block on failure/i });
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => { expect(lastSaved).not.toBeNull(); });
    expect(lastSaved!.SessionStart![0].hooks[0]).not.toHaveProperty('onFailure');
  });

  it('shows a hand-written onFailure:"block" as on', async () => {
    getHooksConfig.mockResolvedValue({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', onFailure: 'block' }] }],
    });
    renderEditor();
    await screen.findByDisplayValue('guard.sh');
    expect(screen.getByRole('switch', { name: /block on failure/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('offers no switch on Stop, where the CLI ignores onFailure', async () => {
    getHooksConfig.mockResolvedValue(REAL_CONFIG);
    renderEditor();
    fireEvent.click(await screen.findByTestId('select-item-Stop'));
    await screen.findByDisplayValue('/Users/me/.claude/hooks/check-unfinished-todos.py');
    expect(screen.queryByRole('switch', { name: /block on failure/i })).toBeNull();
  });
});
