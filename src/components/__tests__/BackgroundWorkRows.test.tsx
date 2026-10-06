// @vitest-environment jsdom
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SubagentRow, ShellRow } from '@/components/BackgroundWorkRows';
import type { Subagent } from '@/lib/subagentStreams';
import type { BackgroundShell, TaskOutputTail } from '@/lib/backgroundShells';

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

describe('SubagentRow meta', () => {
  it('shows a short model label and authoritative stats in the row meta', () => {
    const { container } = render(
      <SubagentRow
        sub={makeSub({
          toolUseId: 'a',
          status: 'completed',
          model: 'claude-haiku-4-5-20251001',
          finalTotalTokens: 71591,
          finalDurationMs: 53161,
          finalToolUseCount: 20,
        })}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('haiku-4-5'); // 'claude-' prefix + date suffix stripped
    expect(text).toContain('20 tools');
    expect(text).toContain('72k tok');
    expect(text).toContain('53s');
  });

  it('shows the subagent\'s own effort in the row meta', () => {
    // A subagent dispatched with `effort: high` under a `medium` session is
    // exactly the case the meta row exists to disambiguate.
    const { container } = render(
      <SubagentRow sub={makeSub({ toolUseId: 'a', status: 'completed', model: 'claude-opus-4-8', effort: 'high' })} />,
    );
    expect(container.textContent ?? '').toContain('high effort');
  });

  it('omits the effort bit entirely when the subagent reports none', () => {
    // Most runs use the session default and carry no effort — a bare
    // separator or an empty slot would be noise.
    const { container } = render(
      <SubagentRow sub={makeSub({ toolUseId: 'a', status: 'completed', model: 'claude-opus-4-8' })} />,
    );
    expect(container.textContent ?? '').not.toContain('effort');
  });

  it('indents a nested subagent under its parent', () => {
    const { container } = render(
      <>
        <SubagentRow sub={makeSub({ toolUseId: 'a', status: 'completed' })} />
        <SubagentRow sub={makeSub({ toolUseId: 'b', status: 'completed', parentToolUseId: 'a' })} />
      </>,
    );
    const rows = container.querySelectorAll('[data-subagent-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-nested')).toBeNull();
    expect(rows[1].getAttribute('data-nested')).toBe('true');
  });

  it('prefers authoritative final stats over the live latest entry', () => {
    const { container } = render(
      <SubagentRow
        sub={makeSub({
          toolUseId: 'a',
          status: 'completed',
          latest: { description: 'mid', totalTokens: 1000, toolUses: 5, durationMs: 2000 },
          finalTotalTokens: 71591,
          finalToolUseCount: 20,
          finalDurationMs: 53161,
        })}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('20 tools');
    expect(text).not.toContain('5 tools');
  });
});

describe('SubagentRow purpose and brief', () => {
  it('heads the row with the dispatch purpose, not the latest progress line', () => {
    const { container } = render(
      <SubagentRow
        sub={makeSub({
          toolUseId: 'a',
          status: 'running',
          description: 'Map the repo',
          latest: { description: 'cd /tmp && ls' },
          events: [{ description: 'cd /tmp && ls' }],
        })}
      />,
    );
    expect(container.querySelector('[data-subagent-purpose]')?.textContent).toBe('Map the repo');
    expect(container.querySelector('[data-subagent-activity]')?.textContent).toBe('cd /tmp && ls');
  });

  it('keeps the purpose on its own line, apart from the meta', () => {
    // The meta used to share the purpose's line and, being shrink-0,
    // squeezed it to zero width on long rows.
    const { container } = render(
      <SubagentRow
        sub={makeSub({ toolUseId: 'a', status: 'running', description: 'Map the repo', model: 'claude-sonnet-5-5' })}
      />,
    );
    const purpose = container.querySelector('[data-subagent-purpose]');
    const meta = container.querySelector('[data-subagent-meta]');
    expect(meta?.textContent).toContain('sonnet-5-5');
    expect(purpose?.parentElement).not.toBe(meta?.parentElement);
  });

  it('falls back to the latest progress line when the dispatch named no purpose', () => {
    const { container } = render(
      <SubagentRow
        sub={makeSub({ toolUseId: 'a', status: 'running', description: '', latest: { description: 'Reading files' } })}
      />,
    );
    expect(container.querySelector('[data-subagent-purpose]')?.textContent).toBe('Reading files');
    // Saying it twice adds nothing.
    expect(container.querySelector('[data-subagent-activity]')).toBeNull();
  });

  it('wraps a long purpose instead of truncating it', () => {
    const { container } = render(
      <SubagentRow sub={makeSub({ toolUseId: 'a', status: 'running', description: 'Survey every service under electron/services and count exports' })} />,
    );
    const purpose = container.querySelector('[data-subagent-purpose]')!;
    expect(purpose.className).not.toContain('truncate');
    expect(purpose.className).toContain('break-words');
  });

  it('draws a divider under each row', () => {
    const { container } = render(<SubagentRow sub={makeSub({ toolUseId: 'a', status: 'running' })} />);
    const row = container.querySelector('[data-subagent-row]')!;
    expect(row.className).toContain('border-b');
    // A bare colour utility loses to the unlayered `* { border-color }` rule
    // in styles.css; only the important arbitrary property reaches the screen.
    expect(row.className).toContain('[border-bottom-color:');
  });

  it('shows the dispatch brief when expanded', () => {
    const { container } = render(
      <SubagentRow sub={makeSub({ toolUseId: 'a', status: 'running', prompt: 'Find every caller of resolve()' })} />,
    );
    expect(container.querySelector('[data-subagent-prompt]')).toBeNull();
    fireEvent.click(container.querySelector('button')!);
    expect(container.querySelector('[data-subagent-prompt]')?.textContent).toContain('Find every caller of resolve()');
  });

  it('shows no brief block for a row without a prompt', () => {
    const { container } = render(<SubagentRow sub={makeSub({ toolUseId: 'a', status: 'running' })} />);
    fireEvent.click(container.querySelector('button')!);
    expect(container.querySelector('[data-subagent-prompt]')).toBeNull();
  });
});

describe('SubagentRow foreground / background', () => {
  it('tags a foreground agent fg', () => {
    render(<SubagentRow sub={makeSub({ toolUseId: 'a', status: 'running', isBackground: false })} />);
    expect(screen.getByText('fg')).toBeTruthy();
    expect(screen.queryByText('bg')).toBeNull();
  });

  it('tags a background agent bg', () => {
    render(<SubagentRow sub={makeSub({ toolUseId: 'a', status: 'running', isBackground: true })} />);
    expect(screen.getByText('bg')).toBeTruthy();
    expect(screen.queryByText('fg')).toBeNull();
  });

  // Nested rows are synthesised from the sidecar and carry no flag. Saying
  // nothing is honest; defaulting to fg would be a guess.
  it('shows no tag when the mode is unknown', () => {
    render(<SubagentRow sub={makeSub({ toolUseId: 'a', status: 'running', parentToolUseId: 'p' })} />);
    expect(screen.queryByText('fg')).toBeNull();
    expect(screen.queryByText('bg')).toBeNull();
  });
});

describe('ShellRow', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const shell = (o: Partial<BackgroundShell> = {}): BackgroundShell => ({
    taskId: 'b1', description: 'npm run dev', status: 'running', ...o,
  });
  const tail = (output: string): TaskOutputTail => ({ output, totalBytes: output.length, truncated: false });

  async function flush() {
    await act(async () => { await Promise.resolve(); });
  }

  it('reads nothing until the row is opened', () => {
    const read = vi.fn(async () => tail('x'));
    render(<ShellRow shell={shell()} read={read} />);
    expect(read).not.toHaveBeenCalled();
  });

  it('polls a running shell while open, as plain text, and stops when closed', async () => {
    const read = vi.fn(async () => tail('\u001b[32mready\u001b[0m on :3000'));
    render(<ShellRow shell={shell()} read={read} />);
    fireEvent.click(screen.getByText('npm run dev'));
    await flush();
    expect(read).toHaveBeenCalledWith('b1');
    expect(screen.getByText('ready on :3000')).toBeTruthy();

    await act(async () => { vi.advanceTimersByTime(2000); });
    await flush();
    expect(read).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByText('npm run dev'));
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads an ended shell once and does not poll', async () => {
    const read = vi.fn(async () => tail('exit 0'));
    render(<ShellRow shell={shell({ status: 'ended' })} read={read} />);
    fireEvent.click(screen.getByText('npm run dev'));
    await flush();
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.getByText('exit 0')).toBeTruthy();
  });

  it('says so when the CLI has no output to give', async () => {
    const read = vi.fn(async () => null);
    render(<ShellRow shell={shell({ status: 'ended' })} read={read} />);
    fireEvent.click(screen.getByText('npm run dev'));
    await flush();
    expect(screen.getByText(/Output not available/)).toBeTruthy();
  });

  it('keeps the last output when a later read comes back empty-handed', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(tail('step 1'))
      .mockResolvedValue(null);
    render(<ShellRow shell={shell()} read={read} />);
    fireEvent.click(screen.getByText('npm run dev'));
    await flush();
    await act(async () => { vi.advanceTimersByTime(2000); });
    await flush();
    expect(screen.getByText('step 1')).toBeTruthy();
  });

  it('notes a truncated tail', async () => {
    const read = vi.fn(async () => ({ output: 'end', totalBytes: 20000, truncated: true }));
    render(<ShellRow shell={shell()} read={read} />);
    fireEvent.click(screen.getByText('npm run dev'));
    await flush();
    expect(screen.getByText(/last 8 KiB/)).toBeTruthy();
  });

  it('dismisses an ended shell', () => {
    const onDismiss = vi.fn();
    render(<ShellRow shell={shell({ status: 'ended' })} read={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('b1');
  });
});
