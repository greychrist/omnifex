// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import { STEP_MARGIN_PX } from '@/lib/transcriptStepper';

// The transcript's contexts all read app_settings over IPC and the message
// bodies are irrelevant here — this file is about which rows become
// navigation anchors, so everything below the row wrapper is stubbed out.
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

afterEach(() => { cleanup(); });

const prompt = (): JsonlNode => ({
  kind: 'user',
  userKind: 'prompt',
  sessionId: 's',
  receivedAt: '2026-07-30T00:00:00.000Z',
  raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } } as never,
});

const compactSummary = (): JsonlNode => ({
  kind: 'user',
  userKind: 'compact-summary',
  sessionId: 's',
  receivedAt: '2026-07-30T00:00:01.000Z',
  raw: {
    type: 'user',
    isCompactSummary: true,
    message: { role: 'user', content: [{ type: 'text', text: 'summary' }] },
  } as never,
});

const assistant = (): JsonlNode => ({
  kind: 'assistant',
  sessionId: 's',
  receivedAt: '2026-07-30T00:00:02.000Z',
  raw: { type: 'assistant', message: { role: 'assistant', content: [] } } as never,
});

function renderTranscript(messages: JsonlNode[]) {
  return render(
    <TooltipProvider>
      <ClaudeTranscript
        messages={messages}
        viewMode="verbose"
        accountType={undefined}
        onResend={() => {}}
        onLinkDetected={() => {}}
        waitingForPermission={false}
        outstandingWork={false}
        hasInflightAssistant={false}
        currentActivity="Thinking"
        totalTokens={0}
        contextLimit={200_000}
        error={null}
        tabId="tab-1"
        messagesEndRef={React.createRef<HTMLDivElement>()}
        isNearBottomRef={{ current: true }}
      />
    </TooltipProvider>,
  );
}

/**
 * Fake layout: jsdom reports every rect as zero, so row positions are
 * supplied here as offsets into the scrolled content. The stub subtracts
 * the live `scrollTop` the way a real rect does — returning a fixed viewport
 * top instead makes every offset drift by however far the test scrolled.
 */
function fakeLayout(container: HTMLElement, rowOffsets: number[]) {
  const scrollEl = container.querySelector('[data-transcript-scroll]') as HTMLElement;
  scrollEl.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>('[data-transcript-scroll] > div > div'),
  );
  rows.forEach((row, i) => {
    const offset = rowOffsets[i];
    if (offset !== undefined) {
      row.getBoundingClientRect = () => ({ top: offset - scrollEl.scrollTop }) as DOMRect;
    }
  });
  const scrollTo = vi.fn();
  scrollEl.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
  return { scrollEl, scrollTo };
}

describe('ClaudeTranscript — navigation anchors', () => {
  it('marks ordinary rows as step stops', () => {
    const { container } = renderTranscript([prompt(), assistant()]);
    expect(container.querySelectorAll('[data-transcript-step]')).toHaveLength(2);
  });

  // The row Greg asked to step past: it is machinery, and it is long.
  it('does not mark a compact summary as a step stop', () => {
    const { container } = renderTranscript([prompt(), compactSummary(), assistant()]);
    expect(container.querySelectorAll('[data-transcript-step]')).toHaveLength(2);
  });

  it('marks only the user prompt as a prompt anchor', () => {
    const { container } = renderTranscript([prompt(), compactSummary(), assistant()]);
    expect(container.querySelectorAll('[data-transcript-prompt]')).toHaveLength(1);
  });

  it('disables both prompt buttons when the session has no prompt yet', () => {
    renderTranscript([assistant()]);
    expect(screen.getByRole('button', { name: /previous prompt/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next prompt/i })).toBeDisabled();
  });

  it('enables the prompt buttons once a prompt exists', () => {
    renderTranscript([prompt(), assistant()]);
    expect(screen.getByRole('button', { name: /previous prompt/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /next prompt/i })).toBeEnabled();
  });
});

describe('ClaudeTranscript — stepping', () => {
  const clickNext = () =>
    fireEvent.click(screen.getByRole('button', { name: /next message/i }));

  it('scrolls to the next row', () => {
    const { container } = renderTranscript([prompt(), assistant(), assistant()]);
    const { scrollTo } = fakeLayout(container, [0, 500, 900]);
    clickNext();
    expect(scrollTo).toHaveBeenCalledWith({ top: 500 - STEP_MARGIN_PX, behavior: 'smooth' });
  });

  // The end-to-end version of the skip: the summary sits between two stops,
  // and one press must clear it rather than land on it.
  it('steps over a compact summary', () => {
    const { container } = renderTranscript([prompt(), compactSummary(), assistant()]);
    const { scrollTo } = fakeLayout(container, [0, 500, 900]);
    clickNext();
    expect(scrollTo).toHaveBeenCalledWith({ top: 900 - STEP_MARGIN_PX, behavior: 'smooth' });
  });

  // Smooth scrolling is async, so `scrollTop` still reads 0 on the second
  // press. Without the pending-target ref both presses resolve to row two.
  it('advances a row per press even before the scroll lands', () => {
    const { container } = renderTranscript([prompt(), assistant(), assistant()]);
    const { scrollTo } = fakeLayout(container, [0, 500, 900]);
    clickNext();
    clickNext();
    expect(scrollTo).toHaveBeenNthCalledWith(2, {
      top: 900 - STEP_MARGIN_PX,
      behavior: 'smooth',
    });
  });

  it('does nothing at the last row', () => {
    const { container } = renderTranscript([prompt()]);
    const { scrollTo } = fakeLayout(container, [0]);
    clickNext();
    expect(scrollTo).not.toHaveBeenCalled();
  });

});

describe('ClaudeTranscript — stepping between prompts', () => {
  // Four rows, prompts at index 0 and 2. The assistant row at 500 sits
  // between them and must be passed over — that is the whole difference
  // from the message stepper above.
  const transcript = () => [prompt(), assistant(), prompt(), assistant()];

  it('skips straight to the next prompt', () => {
    const { container } = renderTranscript(transcript());
    const { scrollTo } = fakeLayout(container, [0, 500, 900, 1400]);
    fireEvent.click(screen.getByRole('button', { name: /next prompt/i }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 900 - STEP_MARGIN_PX, behavior: 'smooth' });
  });

  it('walks back to the prompt above', () => {
    const { container } = renderTranscript(transcript());
    const { scrollEl, scrollTo } = fakeLayout(container, [0, 500, 900, 1400]);
    scrollEl.scrollTop = 1200;
    fireEvent.click(screen.getByRole('button', { name: /previous prompt/i }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 900 - STEP_MARGIN_PX, behavior: 'smooth' });
  });

  it('does nothing at the newest prompt', () => {
    const { container } = renderTranscript(transcript());
    const { scrollEl, scrollTo } = fakeLayout(container, [0, 500, 900, 1400]);
    scrollEl.scrollTop = 1000;
    fireEvent.click(screen.getByRole('button', { name: /next prompt/i }));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  // The two pairs share one pending target — they move the same viewport,
  // so a message step must not be stepped over by a stale prompt position.
  it('picks up from wherever the message stepper left off', () => {
    const { container } = renderTranscript(transcript());
    const { scrollTo } = fakeLayout(container, [0, 500, 900, 1400]);
    fireEvent.click(screen.getByRole('button', { name: /next message/i }));
    expect(scrollTo).toHaveBeenNthCalledWith(1, {
      top: 500 - STEP_MARGIN_PX,
      behavior: 'smooth',
    });
    fireEvent.click(screen.getByRole('button', { name: /next prompt/i }));
    expect(scrollTo).toHaveBeenNthCalledWith(2, {
      top: 900 - STEP_MARGIN_PX,
      behavior: 'smooth',
    });
  });
});
