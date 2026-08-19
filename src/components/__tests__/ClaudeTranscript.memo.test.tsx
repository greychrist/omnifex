// @vitest-environment jsdom
//
// Guards the fix for the tab-switch lag measured in packaged 0.4.133: a single
// tab click cost ~1435 renders / ~110ms, of which 1419 were transcript rows —
// every open session's full, unvirtualised transcript rebuilding just so one
// panel could flip a CSS class.
//
// `isActive` is not a ClaudeTranscript prop. Re-rendering the parent without
// changing anything the transcript reads must therefore not touch a row.
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, cleanup } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import { renderProfiler } from '@/lib/renderProfiler';

vi.mock('@/contexts/MessageRenderingContext', () => ({
  useMessageRenderingConfig: () => ({ config: { hardFilters: {} } }),
}));
vi.mock('@/contexts/AutoScrollContext', () => ({
  useAutoScroll: () => ({ reengagePx: 100, disengagePx: 200 }),
}));
vi.mock('@/contexts/SessionGaugesContext', () => ({
  useSessionGauges: () => ({
    contextTimelineEnabled: false,
    setContextTimelineEnabled: () => {},
    contextJump: { thresholdTokens: 50_000 },
    contextPressure: { enabled: true, mode: 'tokens', value: 250_000 },
  }),
}));
vi.mock('@/components/StreamMessage', () => ({
  StreamMessage: () => <div data-stub-message />,
}));
vi.mock('@/components/InflightAssistantBubble', () => ({
  InflightAssistantBubble: () => null,
}));

import { ClaudeTranscript } from '@/components/claude/ClaudeTranscript';
import { TooltipProvider } from '@/components/ui/tooltip-modern';

afterEach(() => {
  cleanup();
  renderProfiler.setEnabled(false);
});
beforeEach(() => {
  renderProfiler.setEnabled(true);
});

const prompt = (i: number): JsonlNode => ({
  kind: 'user',
  userKind: 'prompt',
  sessionId: 's',
  receivedAt: `2026-07-30T00:00:0${i}.000Z`,
  raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: `go ${i}` }] } } as never,
});

/**
 * Mirrors TabPanel: a parent that re-renders for reasons the transcript does
 * not care about (a tab becoming active/inactive), holding every transcript
 * prop referentially stable across that re-render.
 */
function Harness({ messages, tick }: { messages: JsonlNode[]; tick: number }) {
  // Stable identities, exactly as AgentSession must supply them.
  const onResend = React.useRef(() => {}).current;
  const onLinkDetected = React.useRef(() => {}).current;
  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  const isNearBottomRef = React.useRef(true);
  return (
    <TooltipProvider>
      {/* `tick` changes on every parent render but never reaches the transcript. */}
      <div data-tick={tick} />
      <ClaudeTranscript
        messages={messages}
        viewMode="verbose"
        accountType={undefined}
        onResend={onResend}
        onLinkDetected={onLinkDetected}
        waitingForPermission={false}
        outstandingWork={false}
        hasInflightAssistant={false}
        currentActivity="Thinking"
        totalTokens={0}
        contextLimit={200_000}
        error={null}
        tabId="tab-1"
        messagesEndRef={messagesEndRef}
        isNearBottomRef={isNearBottomRef}
      />
    </TooltipProvider>
  );
}

describe('ClaudeTranscript render cost', () => {
  const messages = [prompt(1), prompt(2), prompt(3)];

  it('does not re-render when the parent re-renders with unchanged props', () => {
    const { rerender } = render(<Harness messages={messages} tick={0} />);

    renderProfiler.begin('tab-switch');
    rerender(<Harness messages={messages} tick={1} />);
    const report = renderProfiler.end();

    const transcript = report?.renders.find(r => r.name === 'ClaudeTranscript');
    expect(transcript).toBeUndefined();
  });

  it('walks no transcript rows when the parent re-renders with unchanged props', () => {
    const { rerender } = render(<Harness messages={messages} tick={0} />);

    renderProfiler.begin('tab-switch');
    rerender(<Harness messages={messages} tick={1} />);
    const report = renderProfiler.end();

    const rows = report?.renders.find(r => r.name === 'TranscriptRow(displayable)');
    expect(rows).toBeUndefined();
  });

  it('still re-renders when the messages actually change', () => {
    const { rerender } = render(<Harness messages={messages} tick={0} />);

    const grown = [...messages, prompt(4)];
    renderProfiler.begin('new-message');
    rerender(<Harness messages={grown} tick={0} />);
    const report = renderProfiler.end();

    expect(report?.renders).toContainEqual({ name: 'ClaudeTranscript', count: 1 });
    expect(report?.renders).toContainEqual({
      name: 'TranscriptRow(displayable)',
      count: 4,
    });
  });
});
