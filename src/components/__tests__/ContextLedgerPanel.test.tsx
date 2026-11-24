// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

// useTheme() throws without a ThemeProvider.
vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'dark' }),
}));

import { ContextLedgerPanel } from '@/components/ContextLedgerPanel';
import type { ContextLedger, LedgerEntry } from '@/lib/contextLedger';

afterEach(() => { cleanup(); });

const entry = (e: Partial<LedgerEntry> & Pick<LedgerEntry, 'kind' | 'label'>): LedgerEntry => ({
  id: `${e.kind}:${e.label}`,
  at: '2026-09-18T10:00:00.000Z',
  live: true,
  ...e,
});

const ledger = (entries: LedgerEntry[], tracked = true, startedAt: string | null = '2026-08-01T10:00:00.000Z'): ContextLedger => ({
  entries,
  liveCount: entries.filter(e => e.live).length,
  tracked,
  startedAt,
});

describe('ContextLedgerPanel', () => {
  describe('untracked sessions', () => {
    it('says the session predates tracking rather than showing an empty list', () => {
      render(<ContextLedgerPanel ledger={ledger([], false)} />);
      expect(screen.getByText(/predates/i)).toBeTruthy();
    });

    it('says nothing is loaded yet before the first prompt, not that the session predates tracking', () => {
      render(<ContextLedgerPanel ledger={ledger([], false, null)} />);
      expect(screen.queryByText(/predates/i)).toBeNull();
      expect(screen.getByText(/first prompt/i)).toBeTruthy();
    });

    it('does not blame the date for a session started after tracking began', () => {
      render(<ContextLedgerPanel ledger={ledger([], false, '2026-10-03T10:00:00.000Z')} />);
      expect(screen.queryByText(/predates/i)).toBeNull();
      expect(screen.getByText(/no context record/i)).toBeTruthy();
    });

    it('does not claim zero sources', () => {
      render(<ContextLedgerPanel ledger={ledger([], false)} />);
      expect(screen.queryByText(/^0 live/)).toBeNull();
    });
  });

  describe('entries', () => {
    it('shows a file by its basename, with the full path available', () => {
      render(<ContextLedgerPanel ledger={ledger([
        entry({ kind: 'instruction-file', label: '/a/b/CLAUDE.md', scope: 'Project', content: 'x' }),
      ])} />);

      expect(screen.getByText('CLAUDE.md')).toBeTruthy();
      expect(screen.getByTitle('/a/b/CLAUDE.md')).toBeTruthy();
    });

    it('renders the scope badge', () => {
      render(<ContextLedgerPanel ledger={ledger([
        entry({ kind: 'instruction-file', label: '/a/CLAUDE.md', scope: 'AutoMem' }),
      ])} />);
      expect(screen.getByText('AutoMem')).toBeTruthy();
    });

    it('distinguishes a superseded entry from a live one', () => {
      render(<ContextLedgerPanel ledger={ledger([
        entry({ kind: 'mcp-server', label: 'gone', live: false, endedAt: '2026-09-18T11:00:00.000Z' }),
        entry({ kind: 'mcp-server', label: 'here', live: true }),
      ])} />);

      expect(screen.getByTestId('entry-mcp-server:gone').getAttribute('data-live')).toBe('false');
      expect(screen.getByTestId('entry-mcp-server:here').getAttribute('data-live')).toBe('true');
    });

    it('does not repeat the count the section heading shows', () => {
      render(<ContextLedgerPanel ledger={ledger([
        entry({ kind: 'mcp-server', label: 'a', live: true }),
        entry({ kind: 'mcp-server', label: 'b', live: false }),
      ])} />);
      expect(screen.queryByText(/live/)).toBeNull();
    });
  });

  describe('grouping', () => {
    it('groups by kind with a count per group', () => {
      render(<ContextLedgerPanel ledger={ledger([
        entry({ kind: 'instruction-file', label: '/a/CLAUDE.md' }),
        entry({ kind: 'mcp-server', label: 'ctx' }),
        entry({ kind: 'mcp-server', label: 'brain' }),
      ])} />);

      expect(screen.getByTestId('group-instruction-file')).toBeTruthy();
      expect(screen.getByTestId('group-mcp-server').textContent).toContain('2');
    });

    it('collapses the high-volume deferred-tool group by default', () => {
      const tools = Array.from({ length: 50 }, (_, i) =>
        entry({ kind: 'deferred-tool', label: `Tool${i}` }));
      render(<ContextLedgerPanel ledger={ledger(tools)} />);

      expect(screen.getByTestId('group-deferred-tool')).toBeTruthy();
      expect(screen.queryByTestId('entry-deferred-tool:Tool0')).toBeNull();
    });

    it('opens the instruction-file group by default', () => {
      render(<ContextLedgerPanel ledger={ledger([
        entry({ kind: 'instruction-file', label: '/a/CLAUDE.md' }),
      ])} />);
      expect(screen.getByTestId('entry-instruction-file:/a/CLAUDE.md')).toBeTruthy();
    });

    it('expands a collapsed group when its header is clicked', () => {
      const tools = [entry({ kind: 'deferred-tool', label: 'Tool0' })];
      render(<ContextLedgerPanel ledger={ledger(tools)} />);

      fireEvent.click(screen.getByTestId('group-deferred-tool'));
      expect(screen.getByTestId('entry-deferred-tool:Tool0')).toBeTruthy();
    });
  });

  describe('content review', () => {
    it('reveals content inline when an entry carrying it is clicked', () => {
      render(<ContextLedgerPanel ledger={ledger([
        entry({ kind: 'instruction-file', label: '/a/CLAUDE.md', content: 'the rules' }),
      ])} />);

      expect(screen.queryByText('the rules')).toBeNull();
      fireEvent.click(screen.getByTestId('entry-instruction-file:/a/CLAUDE.md'));
      expect(screen.getByText('the rules')).toBeTruthy();
    });

    it('collapses content again on a second click', () => {
      render(<ContextLedgerPanel ledger={ledger([
        entry({ kind: 'instruction-file', label: '/a/CLAUDE.md', content: 'the rules' }),
      ])} />);

      const row = screen.getByTestId('entry-instruction-file:/a/CLAUDE.md');
      fireEvent.click(row);
      fireEvent.click(row);
      expect(screen.queryByText('the rules')).toBeNull();
    });

    it('does not make an entry without content clickable', () => {
      render(<ContextLedgerPanel ledger={ledger([
        entry({ kind: 'instruction-file', label: '/a/CLAUDE.md' }),
      ])} />);
      const row = screen.getByTestId('entry-instruction-file:/a/CLAUDE.md');
      expect(row.getAttribute('aria-expanded')).toBeNull();
      expect(row.getAttribute('role')).toBeNull();
    });
  });

  describe('focus', () => {
    it('opens the group and content of the entry it is focused on', () => {
      render(<ContextLedgerPanel
        ledger={ledger([entry({ kind: 'deferred-tool', label: 'Tool0', content: 'schema' })])}
        focusId="deferred-tool:Tool0"
      />);
      expect(screen.getByText('schema')).toBeTruthy();
    });
  });
});

describe('ContextLedgerPanel — content view mode', () => {
  const md = '# Heading\n\nsome **bold** text';
  const withContent = () => ledger([
    entry({ kind: 'instruction-file', label: '/a/CLAUDE.md', content: md }),
  ]);

  const openContent = () => {
    fireEvent.click(screen.getByTestId('entry-instruction-file:/a/CLAUDE.md'));
  };

  it('defaults to the rendered view', () => {
    render(<ContextLedgerPanel ledger={withContent()} />);
    openContent();
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeTruthy();
  });

  it('offers a Rendered/Source toggle only once content is open', () => {
    render(<ContextLedgerPanel ledger={withContent()} />);
    expect(screen.queryByRole('group', { name: /view mode/i })).toBeNull();
    openContent();
    expect(screen.getByRole('group', { name: /view mode/i })).toBeTruthy();
  });

  it('shows raw source when Source is chosen', () => {
    render(<ContextLedgerPanel ledger={withContent()} />);
    openContent();
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));

    expect(screen.queryByRole('heading', { name: 'Heading' })).toBeNull();
    expect(screen.getByTestId('entry-content-source').textContent).toContain('# Heading');
  });

  it('marks which view is active', () => {
    render(<ContextLedgerPanel ledger={withContent()} />);
    openContent();
    expect(screen.getByRole('button', { name: 'Rendered' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.getByRole('button', { name: 'Source' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the chosen view when a different entry is opened', () => {
    render(<ContextLedgerPanel ledger={ledger([
      entry({ kind: 'instruction-file', label: '/a/CLAUDE.md', content: md }),
      entry({ kind: 'instruction-file', label: '/b/CLAUDE.md', content: md }),
    ])} />);

    fireEvent.click(screen.getByTestId('entry-instruction-file:/a/CLAUDE.md'));
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.click(screen.getByTestId('entry-instruction-file:/b/CLAUDE.md'));

    expect(screen.getByRole('button', { name: 'Source' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('entry-content-source')).toBeTruthy();
  });
});

describe('ContextLedgerPanel — sizing', () => {
  it('fills its container rather than sizing itself', () => {
    render(<ContextLedgerPanel ledger={ledger([entry({ kind: 'mcp-server', label: 'ctx' })])} />);
    const el = screen.getByTestId('context-ledger-panel');
    expect(el.className).toMatch(/\bh-full\b/);
    expect(el.style.width).toBe('');
    expect(el.style.height).toBe('');
  });

  it('scrolls its list instead of growing past the container', () => {
    render(<ContextLedgerPanel ledger={ledger(
      Array.from({ length: 40 }, (_, i) => entry({ kind: 'mcp-server', label: `s${i}` })),
    )} />);
    expect(screen.getByTestId('context-ledger-scroll').className).toMatch(/overflow-y-auto/);
  });
});

describe('ContextLedgerPanel — indentation', () => {
  it('indents rows past the group chevron', () => {
    render(<ContextLedgerPanel ledger={ledger([
      entry({ kind: 'instruction-file', label: '/a/CLAUDE.md' }),
    ])} />);

    const group = screen.getByTestId('group-instruction-file');
    const row = screen.getByTestId('entry-instruction-file:/a/CLAUDE.md');

    // The heading pads by 1.5 (6px); the row must clear the chevron and icon
    // that follow it.
    expect(group.className).toMatch(/\bpx-1\.5\b/);
    expect(row.className).toMatch(/pl-\[30px\]/);
  });

  it('indents an entry\'s expanded content to the same column', () => {
    render(<ContextLedgerPanel ledger={ledger([
      entry({ kind: 'instruction-file', label: '/a/CLAUDE.md', content: 'x' }),
    ])} />);

    fireEvent.click(screen.getByTestId('entry-instruction-file:/a/CLAUDE.md'));
    const content = screen.getByTestId('entry-content-rendered').parentElement;
    expect(content?.className).toMatch(/ml-\[30px\]/);
  });
});
