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

const TITLE = 'Edit reported success on a no-op';
const PREVIEW = 'The Edit tool returned success but the file was unchanged.';

/** Build through the real classifier so kind resolution matches production. */
function draftNode(overrides: Record<string, unknown> = {}): JsonlNode {
  return classifyJsonlLine({
    type: 'system',
    subtype: 'feedback_draft_queued',
    draft_id: '0f0c5d6e-6c2e-4a5f-9f1e-2b6a5a0f7c31',
    draft_type: 'bug',
    title: TITLE,
    details_preview: PREVIEW,
    uuid: 'd1a1b0a1-7b2c-4b1e-9a3d-5e2f6c7a8b90',
    session_id: 'sess-1',
    timestamp: '2026-08-27T15:58:49.997Z',
    ...overrides,
  }) as JsonlNode;
}

const kindOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="message-frame"]')?.getAttribute('data-stream-kind');

describe('queued feedback drafts render as their own card', () => {
  it('resolves to system.feedback_draft_queued, not the unknown catch-all', () => {
    const { container } = render(
      <StreamMessage message={draftNode()} streamMessages={[]} />,
    );
    expect(kindOf(container)).toBe('system.feedback_draft_queued');
  });

  it('shows the draft title and the details preview', () => {
    render(<StreamMessage message={draftNode()} streamMessages={[]} />);
    expect(screen.getByText(new RegExp(TITLE))).toBeTruthy();
    expect(screen.getByText(new RegExp(PREVIEW))).toBeTruthy();
  });

  it('names the draft type so a bug reads differently from an idea', () => {
    render(
      <StreamMessage
        message={draftNode({ draft_type: 'missing_capability' })}
        streamMessages={[]}
      />,
    );
    expect(screen.getByText(/missing_capability/)).toBeTruthy();
  });

  it('renders the title alone when the CLI sends no details preview', () => {
    const { container } = render(
      <StreamMessage
        message={draftNode({ details_preview: undefined })}
        streamMessages={[]}
      />,
    );
    expect(kindOf(container)).toBe('system.feedback_draft_queued');
    expect(screen.getByText(new RegExp(TITLE))).toBeTruthy();
  });
});
