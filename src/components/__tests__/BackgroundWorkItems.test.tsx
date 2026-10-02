// @vitest-environment jsdom
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AgentsStatusItem, ShellsStatusItem } from '@/components/BackgroundWorkItems';
import type { Subagent } from '@/lib/subagentStreams';
import type { BackgroundShell } from '@/lib/backgroundShells';

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

const shell = (o: Partial<BackgroundShell> = {}): BackgroundShell => ({
  taskId: 'b1', description: 'npm run dev', status: 'running', ...o,
});

afterEach(() => { cleanup(); });

describe('AgentsStatusItem', () => {
  it('counts the running agents and pulses while any run', () => {
    render(
      <AgentsStatusItem
        subagents={[
          makeSub({ toolUseId: 'a', status: 'running' }),
          makeSub({ toolUseId: 'b', status: 'running' }),
          makeSub({ toolUseId: 'c', status: 'completed' }),
        ]}
      />,
    );
    const item = screen.getByLabelText('agents running');
    expect(item.textContent).toContain('agents');
    expect(item.textContent).toContain('2 running');
    expect(item.className).toContain('animate-pulse');
  });

  // Agents wear the turn readout's sky; shells took the amber agents had.
  it('wears the turn readout\'s sky', () => {
    render(<AgentsStatusItem subagents={[makeSub({ toolUseId: 'a', status: 'running' })]} />);
    expect(screen.getByLabelText('agents running').className).toContain('text-sky-400');
  });

  it('counts the finished agents and holds still once none run', () => {
    render(
      <AgentsStatusItem
        subagents={[
          makeSub({ toolUseId: 'a', status: 'completed' }),
          makeSub({ toolUseId: 'b', status: 'failed' }),
        ]}
      />,
    );
    const item = screen.getByLabelText('agents done');
    expect(item.textContent).toContain('2 done');
    expect(item.className).not.toContain('animate-pulse');
  });

  it('opens a popover listing the agent rows', () => {
    render(
      <AgentsStatusItem
        subagents={[makeSub({ toolUseId: 'a', status: 'running', description: 'Map the repo' })]}
      />,
    );
    expect(screen.queryByText('Map the repo')).toBeNull();
    fireEvent.click(screen.getByLabelText('agents running'));
    expect(screen.getByText('Map the repo')).toBeTruthy();
  });

  it('clears the finished agents from the popover', () => {
    const onDismissAllCompleted = vi.fn();
    render(
      <AgentsStatusItem
        subagents={[
          makeSub({ toolUseId: 'a', status: 'running' }),
          makeSub({ toolUseId: 'b', status: 'completed' }),
        ]}
        onDismissAllCompleted={onDismissAllCompleted}
      />,
    );
    fireEvent.click(screen.getByLabelText('agents running'));
    fireEvent.click(screen.getByText('Clear done (1)'));
    expect(onDismissAllCompleted).toHaveBeenCalledTimes(1);
  });
});

describe('ShellsStatusItem', () => {
  it('counts the running shells and pulses while any run', () => {
    render(
      <ShellsStatusItem
        shells={[shell(), shell({ taskId: 'b2', status: 'ended' })]}
        readShellOutput={vi.fn()}
      />,
    );
    const item = screen.getByLabelText('shells running');
    expect(item.textContent).toContain('shells');
    expect(item.textContent).toContain('1 running');
    expect(item.className).toContain('animate-pulse');
  });

  // Zinc read as part of the cache countdown beside it. Amber since the swap
  // with agents, which took the turn readout's sky.
  it('wears amber, not the cache\'s grey', () => {
    render(<ShellsStatusItem shells={[shell()]} readShellOutput={vi.fn()} />);
    const item = screen.getByLabelText('shells running');
    expect(item.className).toContain('text-amber-400');
    expect(item.className).not.toContain('text-zinc-400');
  });

  it('counts the ended shells once none run', () => {
    render(<ShellsStatusItem shells={[shell({ status: 'ended' })]} readShellOutput={vi.fn()} />);
    const item = screen.getByLabelText('shells done');
    expect(item.textContent).toContain('1 done');
    expect(item.className).not.toContain('animate-pulse');
  });

  it('opens a popover listing the shell rows', () => {
    render(<ShellsStatusItem shells={[shell()]} readShellOutput={vi.fn()} />);
    expect(screen.queryByText('npm run dev')).toBeNull();
    fireEvent.click(screen.getByLabelText('shells running'));
    expect(screen.getByText('npm run dev')).toBeTruthy();
  });

  it('clears the ended shells from the popover', () => {
    const onDismissAllEnded = vi.fn();
    render(
      <ShellsStatusItem
        shells={[shell({ status: 'ended' })]}
        readShellOutput={vi.fn()}
        onDismissAllEnded={onDismissAllEnded}
      />,
    );
    fireEvent.click(screen.getByLabelText('shells done'));
    fireEvent.click(screen.getByText('Clear done (1)'));
    expect(onDismissAllEnded).toHaveBeenCalledTimes(1);
  });
});

describe('background readouts — vertical centring', () => {
  // A popover readout's button must be block-level (`flex`), not `inline-flex`:
  // inside the Popover's block trigger wrapper an inline box opens a line box
  // sized by the inherited line-height, whose descender space sits under the
  // button and lifts it ~1px above the bar's plain readouts. jsdom has no
  // layout, so the display type is what can be pinned.
  it('makes the readout button block-level so it centres with the plain readouts', () => {
    render(<ShellsStatusItem shells={[shell()]} readShellOutput={vi.fn()} />);
    const cls = screen.getByLabelText('shells running').className;
    expect(cls).toMatch(/(^|\s)flex(\s|$)/);
    expect(cls).not.toMatch(/\binline-flex\b/);
  });
});
