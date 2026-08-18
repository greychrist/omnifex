// @vitest-environment jsdom
//
// Claude Code 2.1.234 shipped "Fixed a crash when an API response on the
// non-streaming fallback path (typically via third-party gateways) contained a
// thinking block missing its thinking field or a text block missing its text
// field."
//
// Before that release the CLI died on the shape, so it never reached us. Now
// the CLI tolerates it — which means the field-less block lands in the JSONL
// we render and replay. Every one of our reads was `b.thinking.trim()` /
// `b.text.trim()` against a type that declared the field required, so an
// absent field is a TypeError that blanks the message list (and blanks it
// again on every reload of that session).
//
// StreamMessage catches its own render errors, so the visible damage is not a
// blank app: the offending message collapses into the "Error rendering
// message" card and every sibling block in it — the assistant's actual reply —
// is lost with it, on first render and on every reload of that session.
//
// Contract: a content block missing its narrative field renders as nothing,
// exactly like the empty-string form the CLI already emits for
// signature-only thinking blocks, and its siblings render normally.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
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

function assistantNode(content: unknown[], stop_reason: string | null = null): JsonlNode {
  return {
    kind: 'assistant',
    sessionId: 'sess-1',
    receivedAt: '2026-08-18T10:00:00Z',
    raw: {
      type: 'assistant',
      message: { role: 'assistant', content, stop_reason },
    },
  } as unknown as JsonlNode;
}

function renderNode(node: JsonlNode) {
  return render(<StreamMessage message={node} streamMessages={[node]} />);
}

describe('StreamMessage — content block missing its narrative field (CLI 2.1.234 class)', () => {
  it('does not fall into the error card for a thinking block with no `thinking` field', () => {
    const { container } = renderNode(assistantNode([{ type: 'thinking', signature: 'sig' }]));
    expect(container.textContent).not.toContain('Error rendering message');
  });

  it('does not fall into the error card for a text block with no `text` field', () => {
    const { container } = renderNode(assistantNode([{ type: 'text' }]));
    expect(container.textContent).not.toContain('Error rendering message');
  });

  it('still renders sibling blocks when one block is malformed', () => {
    const { container } = renderNode(
      assistantNode([{ type: 'thinking', signature: 'sig' }, { type: 'text', text: 'survivor' }]),
    );
    expect(container.textContent).toContain('survivor');
    expect(container.textContent).not.toContain('Error rendering message');
  });

  it('renders a terminal-stop_reason message whose only block is malformed', () => {
    // end_turn takes a different branch (assistant.text.endTurn chrome), so it
    // needs its own pass over the same malformed block.
    const { container } = renderNode(assistantNode([{ type: 'text' }], 'end_turn'));
    expect(container.textContent).not.toContain('Error rendering message');
  });
});
