// @vitest-environment jsdom
//
// The main session's calls to the bundled mod's progress tool render as one
// quiet line — "Progress 2/5 — note" — not as an MCP card with a JSON payload.
// Contract: a malformed field falls through to the raw-JSON tool display.
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

function toolUseNode(name: string, input: unknown): JsonlNode {
  return {
    kind: 'assistant',
    sessionId: 'sess-1',
    receivedAt: '2026-08-13T10:00:00Z',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-1', name, input }],
        stop_reason: null,
      },
    },
  } as unknown as JsonlNode;
}

function renderNode(node: JsonlNode) {
  return render(<StreamMessage tabId="tab-test" message={node} streamMessages={[node]} />);
}

describe('StreamMessage — the progress tool', () => {
  it('renders a progress call as a one-line step readout', () => {
    const { container } = renderNode(toolUseNode('mcp__omnifex__progress', { done: 2, total: 5, note: 'Wrote the parser' }));
    const line = container.querySelector('[data-progress-widget]');
    expect(line?.textContent).toContain('Progress');
    expect(line?.textContent).toContain('2/5');
    expect(line?.textContent).toContain('Wrote the parser');
    expect(screen.queryByText(/"total"/)).toBeNull();
  });

  it('falls back to the MCP card when the call cannot draw a step', () => {
    const { container } = renderNode(toolUseNode('mcp__omnifex__progress', { done: 2, total: 0 }));
    expect(container.querySelector('[data-progress-widget]')).toBeNull();
  });
});
