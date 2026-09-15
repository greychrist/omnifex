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

// Unlike the shared StreamMessage suite, this mock surfaces `streamKind` —
// the kind id IS the thing under test here, and it is otherwise invisible
// once MessageFrame has resolved it into styling.
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

const RECAP = 'Session continued. The summary below covers the earlier conversation.';

/** Build through the real classifier so kind resolution matches production. */
function node(raw: Record<string, unknown>): JsonlNode {
  return classifyJsonlLine({
    type: 'user',
    sessionId: 'sess-1',
    timestamp: '2026-07-30T21:08:29.956Z',
    message: { role: 'user', content: [{ type: 'text', text: RECAP }] },
    ...raw,
  }) as JsonlNode;
}

const kindOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="message-frame"]')?.getAttribute('data-stream-kind');

describe('compact summaries get their own card kind', () => {
  it('renders the persisted shape as user.compactSummary, not user.prompt', () => {
    const n = node({ isCompactSummary: true, isVisibleInTranscriptOnly: true });
    const { container } = render(<StreamMessage tabId="tab-test" message={n} streamMessages={[n]} />);
    expect(kindOf(container)).toBe('user.compactSummary');
  });

  // Since the transcript inversion a live row reaches the renderer from the
  // CLI's JSONL, so the "live" shape IS the persisted one — it carries
  // isCompactSummary rather than the old isReplay:false proxy.
  it('renders a directed summarize, which omits isVisibleInTranscriptOnly', () => {
    const n = node({ isCompactSummary: true });
    const { container } = render(<StreamMessage tabId="tab-test" message={n} streamMessages={[n]} />);
    expect(kindOf(container)).toBe('user.compactSummary');
  });

  it('does not render a bare isReplay:false row as a compact summary', () => {
    const n = node({ isReplay: false, isSynthetic: true });
    const { container } = render(<StreamMessage tabId="tab-test" message={n} streamMessages={[n]} />);
    expect(kindOf(container)).not.toBe('user.compactSummary');
  });

  it('leaves an ordinary prompt on user.prompt', () => {
    const n = node({});
    const { container } = render(<StreamMessage tabId="tab-test" message={n} streamMessages={[n]} />);
    expect(kindOf(container)).toBe('user.prompt');
  });

  // Record flags beat content sniffing: isSystemContextText matches on a bare
  // <system-reminder> substring anywhere in the body, and a recap that quotes
  // one would otherwise be relabelled as injected system context.
  it('stays a compact summary even when the recap quotes a system-reminder', () => {
    const n = classifyJsonlLine({
      type: 'user',
      sessionId: 'sess-1',
      timestamp: '2026-07-30T21:08:29.956Z',
      isCompactSummary: true,
      message: {
        role: 'user',
        content: [{ type: 'text', text: `${RECAP}\n<system-reminder>noted</system-reminder>` }],
      },
    }) as JsonlNode;
    const { container } = render(<StreamMessage tabId="tab-test" message={n} streamMessages={[n]} />);
    expect(kindOf(container)).toBe('user.compactSummary');
  });

  it('still renders the recap body', () => {
    const n = node({ isCompactSummary: true });
    render(<StreamMessage tabId="tab-test" message={n} streamMessages={[n]} />);
    expect(screen.getByText(/covers the earlier conversation/)).toBeTruthy();
  });
});
