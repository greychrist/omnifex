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

describe('SubagentBar row meta', () => {
  beforeEach(() => {
    // Expand so the per-subagent rows (and their meta) render.
    window.localStorage.setItem('greychrist.subagentBar.collapsed', '0');
  });

  it('shows a short model label and authoritative stats in the row meta', () => {
    const subs: Subagent[] = [
      makeSub({
        toolUseId: 'a',
        status: 'completed',
        model: 'claude-haiku-4-5-20251001',
        finalTotalTokens: 71591,
        finalDurationMs: 53161,
        finalToolUseCount: 20,
      }),
    ];
    const { container } = render(<SubagentBar subagents={subs} />);
    const text = container.textContent ?? '';
    expect(text).toContain('haiku-4-5'); // 'claude-' prefix + date suffix stripped
    expect(text).toContain('20 tools');
    expect(text).toContain('72k tok');
    expect(text).toContain('53s');
  });

  it('shows the subagent\'s own effort in the row meta', () => {
    // A subagent dispatched with `effort: high` under a `medium` session is
    // exactly the case the meta row exists to disambiguate.
    const subs: Subagent[] = [
      makeSub({ toolUseId: 'a', status: 'completed', model: 'claude-opus-4-8', effort: 'high' }),
    ];
    const { container } = render(<SubagentBar subagents={subs} />);
    expect(container.textContent ?? '').toContain('high effort');
  });

  it('omits the effort bit entirely when the subagent reports none', () => {
    // Most runs use the session default and carry no effort — a bare
    // separator or an empty slot would be noise.
    const subs: Subagent[] = [
      makeSub({ toolUseId: 'a', status: 'completed', model: 'claude-opus-4-8' }),
    ];
    const { container } = render(<SubagentBar subagents={subs} />);
    expect(container.textContent ?? '').not.toContain('effort');
  });

  it('indents a nested subagent under its parent', () => {
    const subs: Subagent[] = [
      makeSub({ toolUseId: 'a', status: 'completed', description: 'Parent work' }),
      makeSub({
        toolUseId: 'b',
        status: 'completed',
        parentToolUseId: 'a',
        description: 'Parent work',
      }),
    ];
    const { container } = render(<SubagentBar subagents={subs} />);
    const rows = container.querySelectorAll('[data-subagent-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-nested')).toBeNull();
    expect(rows[1].getAttribute('data-nested')).toBe('true');
  });

  it('prefers authoritative final stats over the live latest entry', () => {
    const subs: Subagent[] = [
      makeSub({
        toolUseId: 'a',
        status: 'completed',
        latest: { description: 'mid', totalTokens: 1000, toolUses: 5, durationMs: 2000 },
        finalTotalTokens: 71591,
        finalToolUseCount: 20,
        finalDurationMs: 53161,
      }),
    ];
    const { container } = render(<SubagentBar subagents={subs} />);
    const text = container.textContent ?? '';
    expect(text).toContain('20 tools');
    expect(text).not.toContain('5 tools');
  });
});
