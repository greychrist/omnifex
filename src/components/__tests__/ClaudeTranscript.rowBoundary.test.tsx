// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';

vi.mock('@/contexts/MessageRenderingContext', async () => {
  const { createDefaultConfig } = await import('@/lib/messageRenderingConfig');
  const config = createDefaultConfig();
  return {
    useMessageRenderingConfig: () => ({ config }),
    MessageRenderingOverrideProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});
vi.mock('@/contexts/AutoScrollContext', () => ({
  useAutoScroll: () => ({ followPx: 200 }),
}));
vi.mock('@/contexts/SessionGaugesContext', () => ({
  useSessionGauges: () => ({
    contextTimelineEnabled: false,
    setContextTimelineEnabled: () => {},
    contextJump: { thresholdTokens: 50_000 },
    contextPressure: { enabled: true, mode: 'tokens', value: 250_000 },
  }),
}));
// One poisoned message: the second row throws on render, the rest are fine.
vi.mock('@/components/transcript-modern/ModernTranscriptItem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/transcript-modern/ModernTranscriptItem')>()),
  ModernTranscriptItem: ({ item }: { item: { node?: JsonlNode } }) => {
    if ((item.node as { poisoned?: boolean } | undefined)?.poisoned) {
      throw new TypeError('path.split is not a function');
    }
    return <div data-stub-message />;
  },
}));

import { ClaudeTranscript } from '@/components/claude/ClaudeTranscript';
import { TooltipProvider } from '@/components/ui/tooltip-modern';

afterEach(() => { cleanup(); });

const node = (poisoned = false): JsonlNode => ({
  kind: 'user',
  userKind: 'prompt',
  sessionId: 's',
  receivedAt: '2026-08-13T00:00:00.000Z',
  poisoned,
  raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } } as never,
} as unknown as JsonlNode);

function renderTranscript(messages: JsonlNode[]) {
  return render(
    <TooltipProvider>
      <ClaudeTranscript
        messages={messages}
        viewMode="expanded"
        accountType={undefined}
        onResend={() => {}}
        waitingForPermission={false}
        outstandingWork={false}
        hasInflightAssistant={false}
        currentActivity="Thinking"
        contextLimit={200_000}
        error={null}
        tabId="tab-1"
        messagesEndRef={React.createRef<HTMLDivElement>()}
        isNearBottomRef={{ current: true }}
      />
    </TooltipProvider>,
  );
}

describe('ClaudeTranscript — per-row error containment', () => {
  it('contains a throwing message to its own row and keeps the rest of the transcript', () => {
    // React logs the caught error; keep the test output readable.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { container } = renderTranscript([node(), node(true), node()]);
      expect(container.querySelectorAll('[data-stub-message]')).toHaveLength(2);
      expect(screen.getByText(/couldn't be rendered/i)).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves a healthy transcript untouched', () => {
    const { container } = renderTranscript([node(), node()]);
    expect(container.querySelectorAll('[data-stub-message]')).toHaveLength(2);
    expect(screen.queryByText(/couldn't be rendered/i)).toBeNull();
  });
});
