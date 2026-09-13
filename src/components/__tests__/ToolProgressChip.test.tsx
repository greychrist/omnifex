// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import {
  ToolProgressChip,
  formatToolElapsed,
} from '@/components/claude/tools/ToolProgressChip';
import type { ToolProgressEntry } from '@/lib/toolProgress';

afterEach(() => { cleanup(); });

describe('formatToolElapsed', () => {
  it('renders m:ss under an hour', () => {
    expect(formatToolElapsed(42)).toBe('0:42');
    expect(formatToolElapsed(725)).toBe('12:05');
  });

  it('widens to h:mm:ss past an hour', () => {
    expect(formatToolElapsed(3849)).toBe('1:04:09');
  });

  it('floors negatives to zero', () => {
    expect(formatToolElapsed(-5)).toBe('0:00');
  });

  it('floors fractional seconds rather than rounding up', () => {
    expect(formatToolElapsed(59.9)).toBe('0:59');
  });
});

describe('ToolProgressChip', () => {
  const entry: ToolProgressEntry = {
    elapsedSeconds: 30,
    arrivedAtMs: Date.now(),
    retry: null,
  };

  it('renders nothing without an entry', () => {
    const { container } = render(<ToolProgressChip entry={null} done={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing once the tool result has landed', () => {
    const { container } = render(<ToolProgressChip entry={entry} done={true} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows elapsed time while running', () => {
    render(<ToolProgressChip entry={entry} done={false} />);
    expect(screen.getByText(/0:3\d/)).toBeTruthy();
  });

  it('interpolates past the last beat rather than showing a stale value', () => {
    render(
      <ToolProgressChip
        entry={{ ...entry, elapsedSeconds: 30, arrivedAtMs: Date.now() - 20_000 }}
        done={false}
      />,
    );
    // 30s at the beat + ~20s since = ~50s, not the raw 30 the CLI last said.
    expect(screen.getByText(/0:(49|50|51)/)).toBeTruthy();
  });

  it('shows the retry attempt and error category', () => {
    render(
      <ToolProgressChip
        done={false}
        entry={{
          ...entry,
          retry: {
            attempt: 2,
            maxRetries: 3,
            retryDelayMs: 1500,
            errorStatus: 529,
            errorCategory: 'overloaded_error',
          },
        }}
      />,
    );
    expect(screen.getByText(/attempt 2\/3/)).toBeTruthy();
    expect(screen.getByText(/overloaded_error/)).toBeTruthy();
  });

  it('names the HTTP status in the retry tooltip when the CLI supplied one', () => {
    render(
      <ToolProgressChip
        done={false}
        entry={{
          ...entry,
          retry: {
            attempt: 1,
            maxRetries: 3,
            retryDelayMs: 500,
            errorStatus: 529,
            errorCategory: 'overloaded_error',
          },
        }}
      />,
    );
    expect(screen.getByTitle(/HTTP 529/)).toBeTruthy();
  });

  it('omits the status from the tooltip when there was none', () => {
    render(
      <ToolProgressChip
        done={false}
        entry={{
          ...entry,
          retry: {
            attempt: 1,
            maxRetries: 3,
            retryDelayMs: 500,
            errorStatus: null,
            errorCategory: 'timeout',
          },
        }}
      />,
    );
    expect(screen.queryByTitle(/HTTP/)).toBeNull();
    expect(screen.getByTitle(/Retrying in 500ms/)).toBeTruthy();
  });
});
