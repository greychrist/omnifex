// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SessionStatusItem } from '../SessionStatusItem';
import type { SessionSignal } from '@/lib/signals/types';
import type { ContextPressureLevel } from '@/lib/contextPressure';

afterEach(() => { cleanup(); });

const level = (l: ContextPressureLevel): SessionSignal => ({
  id: 'context.level',
  tabId: 't',
  kind: 'state',
  anchor: 'session',
  priority: 'low',
  key: 'context.level',
  title: 'context',
  at: 0,
  meta: { level: l, budgetTokens: 0, budgetPct: 0 },
});

const base = {
  totalTokens: 157_100,
  contextLimit: 1_000_000,
  sessionStatus: 'active' as const,
  promptStatus: 'ready' as const,
  waitingFor: null,
};

const trigger = (): HTMLElement => screen.getByRole('button', { name: /session/i });

describe('SessionStatusItem', () => {
  describe('the readout', () => {
    it('shows the context size and percentage', () => {
      render(<SessionStatusItem {...base} />);
      expect(screen.getByTestId('session-item-context').textContent).toBe('157.1k (16%)');
    });

    // Icon and label wear what the `model` readout's do: no colour of their
    // own, inheriting the bar's, with the label at 70% like every label.
    it.each([
      ['with context', base],
      ['before any context', { ...base, totalTokens: 0 }],
    ] as const)('leaves the icon and label the bar colour, like the model readout (%s)', (_, props) => {
      render(<SessionStatusItem {...props} />);
      const label = screen.getByText('session');
      expect(label.className).toBe('opacity-70');
      let el: HTMLElement | null = label.parentElement;
      while (el && el !== document.body) {
        expect(el.className).not.toMatch(/\btext-muted-foreground\b/);
        el = el.parentElement;
      }
    });

    // A popover readout's button must be block-level (`flex`), not `inline-flex`:
    // inside the Popover's block trigger wrapper an inline box opens a line box
    // sized by the inherited line-height, whose descender space sits under the
    // button and lifts it ~1px above the bar's plain readouts. jsdom has no
    // layout, so the display type is what can be pinned.
    it('makes its button block-level so it centres with the plain readouts', () => {
      render(<SessionStatusItem {...base} />);
      expect(trigger().className).toMatch(/(^|\s)flex(\s|$)/);
      expect(trigger().className).not.toMatch(/\binline-flex\b/);
    });

    // The same glyph as the titlebar's Sessions button (TabStatusPopover).
    it('leads with the Sessions button\'s Atom icon', () => {
      render(<SessionStatusItem {...base} />);
      expect(trigger().querySelector('svg.lucide-atom')).toBeTruthy();
      expect(trigger().querySelector('svg.lucide-database')).toBeNull();
    });

    it.each([
      ['none', 'text-foreground'],
      ['warn', 'text-amber-500'],
      ['critical', 'text-red-500'],
    ] as const)('colours the context by its %s level', (l, cls) => {
      render(<SessionStatusItem {...base} contextLevelSignal={level(l)} />);
      expect(screen.getByTestId('session-item-context').className).toContain(cls);
    });

    // A coloured reading pulses, like the thinking readout, so it is noticed.
    it.each([
      ['none', false],
      ['warn', true],
      ['critical', true],
    ] as const)('pulses the context at the %s level: %s', (l, pulses) => {
      render(<SessionStatusItem {...base} contextLevelSignal={level(l)} />);
      expect(screen.getByTestId('session-item-context').classList.contains('animate-pulse')).toBe(pulses);
    });

    it('says ready, as coloured text rather than a badge', () => {
      render(<SessionStatusItem {...base} />);
      const s = screen.getByTestId('session-item-status');
      expect(s.textContent).toBe('ready');
      expect(s.className).toContain('text-emerald-400');
      expect(s.className).not.toMatch(/\bbg-/);
    });

    it('says working while a turn is in flight', () => {
      render(<SessionStatusItem {...base} promptStatus="working" />);
      const s = screen.getByTestId('session-item-status');
      expect(s.textContent).toBe('working');
      expect(s.className).toContain('text-amber-300');
    });

    it('says what it is waiting on before saying working', () => {
      render(<SessionStatusItem {...base} promptStatus="working" waitingFor="permission" />);
      expect(screen.getByTestId('session-item-status').textContent).toBe('permission');
    });

    // "ready" over a dead process would be a lie.
    it('says closed when the session has ended', () => {
      render(<SessionStatusItem {...base} sessionStatus="ended" />);
      expect(screen.getByTestId('session-item-status').textContent).toBe('closed');
    });

    it('shows the status alone before any context is known', () => {
      render(<SessionStatusItem {...base} totalTokens={0} />);
      expect(screen.getByTestId('session-item-status').textContent).toBe('ready');
      expect(screen.queryByTestId('session-item-context')).toBeNull();
    });
  });

  describe('the popover', () => {
    it('opens the same context details the session widget shows', () => {
      const onCompact = vi.fn();
      render(<SessionStatusItem {...base} onCompact={onCompact} sessionId="abc-123" />);
      fireEvent.click(trigger());
      expect(screen.getByText('Context')).toBeTruthy();
      expect(screen.getByText('abc-123')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /compact now/i }));
      expect(onCompact).toHaveBeenCalledOnce();
    });

    it('marks the session signals read when it closes', () => {
      const onSignalsRead = vi.fn();
      render(<SessionStatusItem {...base} onSignalsRead={onSignalsRead} />);
      fireEvent.click(trigger());
      expect(onSignalsRead).not.toHaveBeenCalled();
      fireEvent.click(trigger());
      expect(onSignalsRead).toHaveBeenCalledOnce();
    });
  });
});

// The Session context panel holds the lists; the popover says how much is
// loaded and opens it.
describe('loadout summary row', () => {
  it('says what is loaded and opens the Session context panel', () => {
    const onOpenLoadout = vi.fn();
    render(<SessionStatusItem {...base} loadout={{ mods: 1, plugins: 14, mcp: 2 }} onOpenLoadout={onOpenLoadout} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('button', { name: '1 mod · 14 plugins · 2 MCP servers' }));
    expect(onOpenLoadout).toHaveBeenCalledTimes(1);
  });

  it('is absent when nothing is known yet', () => {
    render(<SessionStatusItem {...base} loadout={{ mods: null, plugins: null, mcp: null }} onOpenLoadout={vi.fn()} />);
    fireEvent.click(trigger());
    expect(screen.queryByTestId('loadout-summary')).toBeNull();
  });
});

