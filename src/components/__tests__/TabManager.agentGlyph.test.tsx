// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect } from 'vitest';
import { resolveTabStatusIndicator } from '../TabManager';
import type { Tab } from '@/contexts/TabContext';

const NOW = Date.parse('2026-08-19T16:00:00Z');

const tab = (over: Partial<Tab> = {}): Tab =>
  ({
    id: 't1',
    type: 'chat',
    title: 'Session',
    status: 'idle',
    hasUnsavedChanges: false,
    order: 0,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...over,
  }) as Tab;

describe('resolveTabStatusIndicator — background agents', () => {
  it('reports the running agent count, so a background tab says what it is waiting on', () => {
    // The reason this exists: a backgrounded agent's launching turn is over,
    // so the tab is "working" with nothing visibly happening in it. A bare
    // spinner can't distinguish that from Claude mid-sentence.
    expect(
      resolveTabStatusIndicator(tab({ promptStatus: 'working', activeAgents: 2 }), NOW),
    ).toEqual({ kind: 'agents', count: 2 });
  });

  it('outranks the spinner — the count is strictly more information', () => {
    expect(
      resolveTabStatusIndicator(tab({ promptStatus: 'working', activeAgents: 1 }), NOW),
    ).toEqual({ kind: 'agents', count: 1 });
  });

  it('falls back to the spinner when the work is main-turn only', () => {
    expect(
      resolveTabStatusIndicator(tab({ promptStatus: 'working', activeAgents: 0 }), NOW),
    ).toEqual({ kind: 'spinner' });
  });

  it('still yields to what the user can act on', () => {
    expect(
      resolveTabStatusIndicator(tab({ promptStatus: 'working', activeAgents: 2, waitingFor: 'permission' }), NOW),
    ).toEqual({ kind: 'permission' });
    expect(
      resolveTabStatusIndicator(tab({ promptStatus: 'working', activeAgents: 2, status: 'error' }), NOW),
    ).toEqual({ kind: 'error' });
  });

  it('shows nothing once the agents finish and the tab goes quiet', () => {
    expect(
      resolveTabStatusIndicator(tab({ promptStatus: 'ready', activeAgents: 0 }), NOW),
    ).toBeNull();
  });
});

describe('AgentCountGlyph', () => {
  it('names how many agents are working, for screen readers and the tooltip', async () => {
    const { render, screen, cleanup } = await import('@testing-library/react');
    const { AgentCountGlyph } = await import('../TabManager');
    render(<AgentCountGlyph count={3} />);
    expect(screen.getByLabelText('3 background agents working')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    cleanup();
  });

  it('drops the numeral for a single agent — the bot is the message', async () => {
    const { render, screen, cleanup } = await import('@testing-library/react');
    const { AgentCountGlyph } = await import('../TabManager');
    render(<AgentCountGlyph count={1} />);
    expect(screen.getByLabelText('1 background agent working')).toBeInTheDocument();
    expect(screen.queryByText('1')).toBeNull();
    cleanup();
  });
});
