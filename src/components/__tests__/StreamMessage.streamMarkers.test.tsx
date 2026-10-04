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

const kindOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="message-frame"]')?.getAttribute('data-stream-kind');

/** A real 2.1.289 compact_boundary record, through the real classifier. */
function boundaryNode(metadata: Record<string, unknown> | undefined): JsonlNode {
  return classifyJsonlLine({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    level: 'info',
    ...(metadata ? { compactMetadata: metadata } : {}),
    uuid: 'e876d068-f1af-4955-a07b-62ed52eb7ab1',
    sessionId: 'sess-1',
    timestamp: '2026-10-04T08:51:32.723Z',
  }) as JsonlNode;
}

function resultNode(overrides: Record<string, unknown> = {}): JsonlNode {
  return classifyJsonlLine({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 58100,
    num_turns: 3,
    session_id: 'sess-1',
    timestamp: '2026-10-04T08:51:32.976Z',
    ...overrides,
  }) as JsonlNode;
}

function initNode(): JsonlNode {
  return classifyJsonlLine({
    type: 'system',
    subtype: 'init',
    model: 'claude-opus-5-5[1m]',
    cwd: '/Users/g/Repos/omnifex',
    session_id: 'sess-1',
    timestamp: '2026-10-04T08:00:00.000Z',
  }) as JsonlNode;
}

describe('compaction boundaries render as their own kind', () => {
  it('resolves to system.compact_boundary, not the unknown catch-all', () => {
    const { container } = render(
      <StreamMessage tabId="t" message={boundaryNode({ trigger: 'manual' })} streamMessages={[]} />,
    );
    expect(kindOf(container)).toBe('system.compact_boundary');
  });

  it('says what triggered it, how far context shrank, and how long it took', () => {
    render(
      <StreamMessage tabId="t"
        message={boundaryNode({ trigger: 'manual', preTokens: 465250, postTokens: 11410, durationMs: 58080 })}
        streamMessages={[]}
      />,
    );
    expect(screen.getByText('Conversation compacted · manual · 465k → 11k tokens · 58.08s')).toBeTruthy();
  });

  it('falls back to the bare line when the record carries no metadata', () => {
    render(<StreamMessage tabId="t" message={boundaryNode(undefined)} streamMessages={[]} />);
    expect(screen.getByText('Conversation compacted')).toBeTruthy();
  });
});

describe('stream envelopes render through the kind registry', () => {
  it('a turn result resolves to system.result with its outcome, duration and turns', () => {
    const { container } = render(<StreamMessage tabId="t" message={resultNode()} streamMessages={[]} />);
    expect(kindOf(container)).toBe('system.result');
    expect(screen.getByText('success · 58.10s · 3 turns')).toBeTruthy();
  });

  it('a single-turn result says "1 turn"', () => {
    render(<StreamMessage tabId="t" message={resultNode({ num_turns: 1 })} streamMessages={[]} />);
    expect(screen.getByText('success · 58.10s · 1 turn')).toBeTruthy();
  });

  it('a session init resolves to system.init with its model and folder', () => {
    const { container } = render(<StreamMessage tabId="t" message={initNode()} streamMessages={[]} />);
    expect(kindOf(container)).toBe('system.init');
    expect(screen.getByText('claude-opus-5-5[1m] · /Users/g/Repos/omnifex')).toBeTruthy();
  });
});
