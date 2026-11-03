// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

vi.mock('@/contexts/MessageRenderingContext', async () => {
  const { createDefaultConfig } = await import('@/lib/messageRenderingConfig');
  return { useMessageRenderingConfig: () => ({ config: createDefaultConfig(), setConfig: () => {}, loaded: true }) };
});

vi.mock('@/components/StreamMessage/MessageFrame', () => ({
  MessageFrame: ({ streamKind, children }: { streamKind?: string; children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'message-frame', 'data-stream-kind': streamKind }, children),
}));

vi.mock('@/components/CardActionBar', () => ({
  CardActionBar: () => null,
  CardActionButton: () => null,
  CardActionDivider: () => null,
}));

import { StreamMessage } from '../StreamMessage';
import { classifyJsonlLine } from '@/lib/jsonlClassifier';
import type { JsonlNode } from '@/types/jsonl';
import { lookupsFor } from './rowLookupsFor';

afterEach(() => cleanup());

const node = classifyJsonlLine({
  type: 'system',
  subtype: 'session_writes_lost',
  error_code: 'ENOSPC',
  lost: ['transcript'],
  transcript_session_ids: ['sess-1'],
  uuid: 'b0c1d2e3-0000-4000-8000-000000000001',
  session_id: 'sess-1',
  // Stream-only: the engine's envelope stamps receivedAt (claude-cli-engine.ts).
  receivedAt: '2026-11-02T22:00:00.000Z',
}) as JsonlNode;

describe('session_writes_lost (CLI 2.1.317) renders as an error card', () => {
  it('is classified, not the Unrecognized catch-all', () => {
    expect(node.kind).toBe('system');
  });

  it('draws in the API error kind with the CLI\'s explanation', () => {
    const { container } = render(<StreamMessage tabId="t" message={node} lookups={lookupsFor(node, [])} />);
    expect(container.querySelector('[data-testid="message-frame"]')?.getAttribute('data-stream-kind')).toBe('system.api_error');
    expect(screen.getByText(/the disk is full/)).toBeTruthy();
    expect(screen.queryByText(/system\.session_writes_lost/)).toBeNull();
  });
});
