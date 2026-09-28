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

// Real shapes from CLI 2.1.284 sessions (~/.omnifex/sessions, Sep 2026).
const BLOCK =
  'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Irreversible Local Destruction]. If you have other tasks that don\'t depend on this action, continue working on those.';

const toolUse = classifyJsonlLine({
  type: 'assistant', uuid: 'a1', sessionId: 'sess-1', timestamp: '2026-09-28T17:18:53.000Z',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'rm -rf build' } }] },
}) as JsonlNode;

const deniedEvent = classifyJsonlLine({
  type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'toolu_1',
  decision_reason_type: 'classifier', decision_reason: '[Irreversible Local Destruction]', message: BLOCK,
  uuid: 'd1', session_id: 'sess-1', receivedAt: '2026-09-28T17:18:53.050Z',
}) as JsonlNode;

const deniedResult = classifyJsonlLine({
  type: 'user', uuid: 'u1', sessionId: 'sess-1', timestamp: '2026-09-28T17:18:53.100Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: BLOCK }] },
}) as JsonlNode;

describe('auto-mode denials render as an actionable card', () => {
  it('renders the live permission_denied event as the card, with the command it blocked', () => {
    render(<StreamMessage tabId="t" message={deniedEvent} streamMessages={[toolUse, deniedEvent]} />);
    expect(screen.getByText('Auto mode blocked this')).toBeTruthy();
    expect(screen.getByText('Irreversible Local Destruction')).toBeTruthy();
    expect(screen.getByText('`rm -rf build`')).toBeTruthy();
  });

  // After a reload the event is gone (the CLI never writes it to the JSONL);
  // the tool_result is all that is left, and it rebuilds the card.
  it('rebuilds the card from the tool_result when the event is gone', () => {
    render(<StreamMessage tabId="t" message={deniedResult} streamMessages={[toolUse, deniedResult]} />);
    expect(screen.getByText('Auto mode blocked this')).toBeTruthy();
    expect(screen.getByText('`rm -rf build`')).toBeTruthy();
  });

  it('does not render the card twice when the live event is present', () => {
    render(<StreamMessage tabId="t" message={deniedResult} streamMessages={[toolUse, deniedEvent, deniedResult]} />);
    expect(screen.queryByText('Auto mode blocked this')).toBeNull();
  });
});
