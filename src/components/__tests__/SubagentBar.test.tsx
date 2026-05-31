// @vitest-environment jsdom
import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SubagentBar } from '@/components/SubagentBar';
import type { Subagent } from '@/lib/subagentStreams';

function makeSub(overrides: Partial<Subagent> & Pick<Subagent, 'toolUseId' | 'status'>): Subagent {
  return {
    agentType: 'Explore',
    description: 'Working',
    colorIndex: 0,
    events: [],
    latest: null,
    ...overrides,
  };
}

afterEach(() => { cleanup(); });

describe('SubagentBar header spinner', () => {
  beforeEach(() => {
    // Keep the bar collapsed so only header chrome renders.
    window.localStorage.setItem('greychrist.subagentBar.collapsed', '1');
  });

  it('renders exactly one spinner while a subagent is running', () => {
    const subs: Subagent[] = [
      makeSub({ toolUseId: 'a', status: 'running' }),
      makeSub({ toolUseId: 'b', status: 'completed' }),
    ];
    const { container } = render(<SubagentBar subagents={subs} />);
    // The "N running" pill carries the only spinner; no redundant
    // standalone status spinner beside it.
    const spinners = container.querySelectorAll('.animate-spin');
    expect(spinners.length).toBe(1);
  });

  it('renders no spinner when nothing is running', () => {
    const subs: Subagent[] = [makeSub({ toolUseId: 'b', status: 'completed' })];
    const { container } = render(<SubagentBar subagents={subs} />);
    expect(container.querySelectorAll('.animate-spin').length).toBe(0);
  });
});
