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
import { resolveKind, createDefaultConfig } from '@/lib/messageRenderingConfig';
import type { JsonlNode } from '@/types/jsonl';

afterEach(() => {
  cleanup();
});

// A mod's $.ui.log / $.ui.toast in a headless session arrives as a system
// frame instead of being drawn (verified live on CLI 2.1.288). It is the
// mod speaking to the user, so it renders, under the plugin's name.
function modLine(subtype: 'ui_log' | 'ui_toast', text: string): JsonlNode {
  return classifyJsonlLine({
    type: 'system',
    subtype,
    plugin: 'token-weather',
    text,
    uuid: 'a1a1b0a1-7b2c-4b1e-9a3d-5e2f6c7a8b90',
    session_id: 'sess-1',
    receivedAt: '2026-10-03T10:00:00Z',
  })!;
}

const kindOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="message-frame"]')?.getAttribute('data-stream-kind');

describe('mod log and toast lines', () => {
  it.each(['ui_log', 'ui_toast'] as const)('renders system:%s as its own kind with the plugin name', (subtype) => {
    const { container } = render(
      <StreamMessage tabId="tab-test" message={modLine(subtype, 'Clear · 41% used')} streamMessages={[]} />,
    );
    expect(kindOf(container)).toBe(`system.${subtype}`);
    expect(screen.getByText('token-weather · Clear · 41% used')).toBeTruthy();
  });

  it.each(['ui_log', 'ui_toast'])('system.%s is shown by default', (subtype) => {
    expect(resolveKind(createDefaultConfig(), `system.${subtype}`).visibility).not.toBe('never');
  });
});
