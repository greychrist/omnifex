// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

vi.mock('@/contexts/MessageRenderingContext', async () => {
  const { createDefaultConfig } = await import('@/lib/messageRenderingConfig');
  return {
    useMessageRenderingConfig: () => ({
      config: createDefaultConfig(),
      setConfig: () => {},
      loaded: true,
    }),
  };
});

// Surfaces `streamKind` so the resolved kind id is assertable — MessageFrame
// otherwise absorbs it into styling.
vi.mock('@/components/StreamMessage/MessageFrame', () => ({
  MessageFrame: ({
    streamKind,
    children,
  }: {
    streamKind?: string;
    children: React.ReactNode;
  }) =>
    React.createElement(
      'div',
      { 'data-testid': 'message-frame', 'data-stream-kind': streamKind },
      children,
    ),
}));

vi.mock('@/components/CardActionBar', () => ({
  CardActionBar: () => null,
  CardActionButton: () => null,
  CardActionDivider: () => null,
}));

import { StreamMessage } from '../StreamMessage';
import { classifyJsonlLine } from '@/lib/jsonlClassifier';
import type { JsonlNode } from '@/types/jsonl';

afterEach(() => {
  cleanup();
});

/** A real record from a 2.1.283 transcript, through the real classifier. */
function summaryNode(overrides: Record<string, unknown> = {}): JsonlNode {
  return classifyJsonlLine({
    type: 'system',
    subtype: 'stop_hook_summary',
    hookCount: 1,
    hookInfos: [{ command: '/Users/g/.claude-personal/hooks/check-unfinished-todos.py', durationMs: 37 }],
    hookErrors: [],
    hookAdditionalContext: [],
    preventedContinuation: false,
    stopReason: '',
    hasOutput: false,
    level: 'suggestion',
    uuid: '3d9808ea-ea1f-4347-ba11-c947b0d87364',
    sessionId: 'sess-1',
    timestamp: '2026-09-28T15:33:20.254Z',
    ...overrides,
  }) as JsonlNode;
}

const kindOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="message-frame"]')?.getAttribute('data-stream-kind');

describe('stop hook summaries render as their own card', () => {
  it('resolves to system.stop_hook_summary, not the unknown catch-all', () => {
    const { container } = render(<StreamMessage tabId="t" message={summaryNode()} streamMessages={[]} />);
    expect(kindOf(container)).toBe('system.stop_hook_summary');
  });

  it('names each hook by its file and says how long it took', () => {
    render(<StreamMessage tabId="t" message={summaryNode()} streamMessages={[]} />);
    expect(screen.getByText('check-unfinished-todos.py · 37ms')).toBeTruthy();
  });

  it('says when a hook errored or blocked the stop', () => {
    render(
      <StreamMessage tabId="t"
        message={summaryNode({
          hookInfos: [{ command: '/a/lint.sh', durationMs: 1200 }, { command: '/b/todos.py', durationMs: 30 }],
          hookErrors: ['exit 2'],
          preventedContinuation: true,
          stopReason: 'unfinished todos',
        })}
        streamMessages={[]}
      />,
    );
    expect(screen.getByText('lint.sh · 1200ms, todos.py · 30ms · 1 error · blocked stop: unfinished todos')).toBeTruthy();
  });
});
