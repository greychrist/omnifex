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
        const { initial, animate, exit, transition, layout, whileTap, ...domProps } = rest;
        void initial; void animate; void exit; void transition; void layout; void whileTap;
        return React.createElement(Tag, { ...domProps, ref }, children);
      });
    },
  }),
  AnimatePresence: ({ children }: any) => children,
}));

// Radix Select relies on pointer-capture APIs jsdom doesn't implement, so
// its dropdown never opens under fireEvent. Swap in a flat stand-in that
// renders every item and calls onValueChange on click — this test is about
// HooksEditor's behaviour, not Radix's.
vi.mock('@/components/ui/select', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory hoisted before module imports settle.
  const React = require('react');
  const Ctx = React.createContext({} as { onValueChange?: (v: string) => void });
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

/**
 * The exact shape a real Stop hook has on disk. The editor used to model
 * Stop as a FLAT `HookCommand[]`, so it read this as a command row with an
 * undefined `command` — the hook rendered blank and saving corrupted it.
 */
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
    // The bug: the editor wrote `Stop: [{type:'command', command:'…'}]`,
    // dropping the `hooks` nesting, which the CLI never executes. Editing
    // must preserve the envelope — matcher included — and only change the
    // command. (The no-edit round trip is covered at the pure-function level
    // in hooksManager.shape.test.ts; driving it through a controlled
    // textarea only tests React's change tracking.)
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

    // SessionStart matches on how the session started — not on tool names.
    expect(await screen.findByLabelText('How the session started')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/startup, resume, clear/),
    ).toBeInTheDocument();
  });

  it('offers NO matcher field for an always-fire event', async () => {
    // The CLI silently ignores `matcher` on Stop, so a filter box there
    // would invite a rule that does nothing.
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
