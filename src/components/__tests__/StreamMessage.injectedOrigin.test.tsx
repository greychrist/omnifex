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
    useMessageRenderingConfig: () => ({ config: createDefaultConfig(), setConfig: () => {}, loaded: true }),
  };
});

// Surface the resolved kind — that is the whole assertion here.
vi.mock('@/components/StreamMessage/MessageFrame', () => ({
  MessageFrame: ({ streamKind, children }: { streamKind: string; children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'message-frame', 'data-stream-kind': streamKind }, children),
}));

vi.mock('@/components/CardActionBar', () => ({
  CardActionBar: () => null,
  CardActionButton: () => null,
  CardActionDivider: () => null,
}));

import { StreamMessage } from '../StreamMessage';
import type { JsonlNode } from '@/types/jsonl';

afterEach(() => { cleanup(); });

function userNode(text: string, extra: Record<string, unknown> = {}): JsonlNode {
  return {
    kind: 'user',
    sessionId: 'sess-1',
    receivedAt: '2026-09-15T10:00:00Z',
    uuid: 'u-1',
    raw: {
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: [{ type: 'text', text }] },
      ...extra,
    },
  } as unknown as JsonlNode;
}

function kindOf(node: JsonlNode): string | null {
  render(<StreamMessage message={node} streamMessages={[node]} tabId="tab-1" />);
  return screen.getByTestId('message-frame').getAttribute('data-stream-kind');
}

describe('StreamMessage — records the CLI stamped as injected', () => {
  it('does not render a background task notification as the user prompt', () => {
    const node = userNode(
      '<task-notification>\n<status>completed</status>\n</task-notification>',
      { origin: { kind: 'task-notification' }, promptSource: 'sdk' },
    );
    expect(kindOf(node)).toBe('user.taskNotification');
  });

  // Real coordinator records also carry isMeta, and non-skill isMeta user
  // records are dropped before any of this — so this one never reached the
  // prompt bug. Pinned so the drop stays deliberate rather than becoming a
  // surprise if the isMeta rule changes.
  it('renders nothing for a coordinator message carrying isMeta', () => {
    const node = userNode(
      'The coordinator sent a message while you were working:\nTask 8 fix round 1',
      { origin: { kind: 'coordinator' }, isMeta: true },
    );
    render(<StreamMessage message={node} streamMessages={[node]} tabId="tab-1" />);
    expect(screen.queryByTestId('message-frame')).toBeNull();
  });

  it('classifies a coordinator message that is not isMeta as its own kind', () => {
    const node = userNode(
      'The coordinator sent a message while you were working:\nTask 8 fix round 1',
      { origin: { kind: 'coordinator' } },
    );
    expect(kindOf(node)).toBe('user.coordinatorMessage');
  });

  it('still renders a typed prompt as the user prompt', () => {
    expect(kindOf(userNode('what happened with this message?', { origin: { kind: 'human' } })))
      .toBe('user.prompt');
  });

  it('still renders an unstamped prompt as the user prompt', () => {
    expect(kindOf(userNode('plain prompt'))).toBe('user.prompt');
  });
});
