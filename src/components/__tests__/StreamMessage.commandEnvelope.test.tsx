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

vi.mock('@/components/StreamMessage/MessageFrame', () => ({
  MessageFrame: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'message-frame' }, children),
}));

vi.mock('@/components/CardActionBar', () => ({
  CardActionBar: () => null,
  CardActionButton: () => null,
  CardActionDivider: () => null,
}));

import { StreamMessage } from '../StreamMessage';
import type { JsonlNode } from '@/types/jsonl';

afterEach(() => { cleanup(); });

function userNode(text: string): Extract<JsonlNode, { kind: 'user' }> {
  return {
    kind: 'user',
    sessionId: 'sess-1',
    receivedAt: '2026-09-15T10:00:00Z',
    uuid: 'u-1',
    raw: {
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
  } as unknown as Extract<JsonlNode, { kind: 'user' }>;
}

describe('StreamMessage slash-command envelope', () => {
  // Regression: the CLI persists custom/skill-backed commands message-first
  // with no <command-args>, which the old ordered regex could not match, so
  // the raw pseudo-XML was printed into the card.
  it('renders the message-first, args-less envelope as a command widget', () => {
    const node = userNode(
      '<command-message>timesheet-review</command-message>\n'
      + '<command-name>/timesheet-review</command-name>',
    );
    render(<StreamMessage message={node} streamMessages={[node]} tabId="tab-1" />);

    expect(screen.getByText('/timesheet-review')).toBeTruthy();
    expect(screen.queryByText(/<command-name>/)).toBeNull();
    expect(document.body.textContent).not.toContain('<command-message>');
  });

  it('still renders the name-first envelope with args', () => {
    const node = userNode(
      '<command-name>/usage</command-name>\n<command-message>usage</command-message>\n<command-args>--json</command-args>',
    );
    render(<StreamMessage message={node} streamMessages={[node]} tabId="tab-1" />);

    expect(screen.getByText('/usage')).toBeTruthy();
    expect(screen.getByText('--json')).toBeTruthy();
    expect(document.body.textContent).not.toContain('<command-args>');
  });
});
