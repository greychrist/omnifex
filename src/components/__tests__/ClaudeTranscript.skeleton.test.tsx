// @vitest-environment jsdom
//
// The skeleton a transcript shows while its rows render in a transition.
// Transitions are held open here, so the skeleton stays up to be measured.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import { createDefaultConfig } from '@/lib/messageRenderingConfig';
import { MessageRenderingPreviewProvider } from '@/contexts/MessageRenderingContext';

vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));
vi.mock('@/contexts/AutoScrollContext', () => ({
  useAutoScroll: () => ({ followPx: 200 }),
}));
const gauges = vi.hoisted(() => ({ timelineOn: false }));
vi.mock('@/contexts/SessionGaugesContext', () => ({
  useSessionGauges: () => ({
    contextTimelineEnabled: gauges.timelineOn,
    setContextTimelineEnabled: () => {},
    contextJump: { thresholdTokens: 50_000 },
    contextPressure: { enabled: true, mode: 'tokens', value: 250_000 },
  }),
}));
vi.mock('@/components/StreamMessage', () => ({
  StreamMessage: ({ message }: { message: JsonlNode }) => <div data-stream-row={message.kind} />,
}));
vi.mock('@/components/InflightAssistantBubble', () => ({
  InflightAssistantBubble: () => <div data-classic-live-answer />,
}));

vi.mock('react', async (orig) => {
  const actual = await orig<typeof import('react')>();
  return { ...actual, startTransition: () => {} };
});

import { ClaudeTranscript } from '@/components/claude/ClaudeTranscript';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import { TooltipProvider } from '@/components/ui/tooltip-modern';

afterEach(() => { cleanup(); useClaudeSessionStore.getState().__resetForTests(); gauges.timelineOn = false; });

const prompt = {
  kind: 'user', userKind: 'prompt', sessionId: 's', receivedAt: '2026-10-28T10:00:00Z',
  raw: { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'Fix the parser' }] } },
} as unknown as JsonlNode;
const assistant = (uuid: string, blocks: unknown[]) => ({
  kind: 'assistant', sessionId: 's', receivedAt: '2026-10-28T10:00:01Z',
  raw: { type: 'assistant', uuid, message: { role: 'assistant', content: blocks, stop_reason: null } },
} as unknown as JsonlNode);
const toolResult = {
  kind: 'user', userKind: 'tool-result', sessionId: 's', receivedAt: '',
  raw: { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
} as unknown as JsonlNode;

const messages = [
  prompt,
  assistant('a1', [{ type: 'thinking', thinking: 'Check the regex first.', signature: 's' }]),
  assistant('a2', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }]),
  toolResult,
  assistant('a3', [{ type: 'text', text: 'All **green**.' }]),
];

function renderModern(outstandingWork = false, rows: JsonlNode[] = messages, onResend: (text: string, images?: string[]) => void = () => {}, waitingForPermission = false, currentActivity = 'Thinking') {
  return render(
    <MessageRenderingPreviewProvider config={createDefaultConfig()}>
      <TooltipProvider>
        <ClaudeTranscript
          messages={rows}
          viewMode="modern"
          accountType={undefined}
          onResend={onResend}
          waitingForPermission={waitingForPermission}
          outstandingWork={outstandingWork}
          hasInflightAssistant={false}
          currentActivity={currentActivity}
          totalTokens={0}
          contextLimit={200_000}
          error={null}
          tabId="tab-1"
          messagesEndRef={React.createRef<HTMLDivElement>()}
          isNearBottomRef={{ current: true }}
        />
      </TooltipProvider>
    </MessageRenderingPreviewProvider>,
  );
}

describe('ClaudeTranscript — skeleton', () => {
  // With the rail on, rows bring their own gutter and the transcript has no
  // left inset of its own; the skeleton must sit in a row like everything
  // else, or it starts in the gutter, outside the chat frame.
  it('draws the skeleton inside the chat frame when the context rail is on', () => {
    gauges.timelineOn = true;
    const { container } = renderModern();
    const skeleton = screen.getByRole('status');
    expect(skeleton).toHaveTextContent('Loading conversation');
    const row = skeleton.parentElement?.parentElement as HTMLElement;
    expect(row.querySelector(':scope > [data-timeline-gutter]')).not.toBeNull();
    expect(container.querySelector('[data-transcript-frame]')).not.toBeNull();
  });

  it('needs no gutter when the rail is off', () => {
    renderModern();
    expect(screen.getByText('Loading conversation')).toBeInTheDocument();
    expect(document.querySelector('[data-timeline-gutter]')).toBeNull();
  });
});
