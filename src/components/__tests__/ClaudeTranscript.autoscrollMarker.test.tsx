// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';

// The transcript's contexts read app_settings over IPC and the message bodies
// are irrelevant here — this file is about the auto-scroll follow marker.
vi.mock('@/contexts/MessageRenderingContext', () => ({
  useMessageRenderingConfig: () => ({ config: {} }),
}));
vi.mock('@/contexts/AutoScrollContext', () => ({
  useAutoScroll: () => ({ followPx: 240 }),
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
import { USER_SCROLL_INTENT_MS } from '@/lib/autoScrollFollow';
import { TooltipProvider } from '@/components/ui/tooltip-modern';

afterEach(() => { cleanup(); });

function renderTranscript(isNearBottomRef = { current: true }) {
  return render(
    <TooltipProvider>
      <ClaudeTranscript
        messages={[] as JsonlNode[]}
        viewMode="verbose"
        accountType={undefined}
        onResend={() => {}}
        waitingForPermission={false}
        outstandingWork={false}
        hasInflightAssistant={false}
        currentActivity="Thinking"
        totalTokens={0}
        contextLimit={200_000}
        error={null}
        tabId="tab-1"
        messagesEndRef={React.createRef<HTMLDivElement>()}
        isNearBottomRef={isNearBottomRef}
      />
    </TooltipProvider>,
  );
}

function fakeScroll(el: HTMLElement, m: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: m.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: m.clientHeight });
  el.scrollTop = m.scrollTop;
  fireEvent.scroll(el);
}

/**
 * Following is decided by `distanceFromBottom <= followPx`. A marker anchored
 * in the CONTENT `followPx` above its end is therefore on screen exactly when
 * the transcript is following — a viewport-fixed marker could not show that,
 * since the threshold is measured below the visible area.
 */
describe('ClaudeTranscript — auto-scroll follow marker', () => {
  it('sits followPx above the end of the content, against the right edge', () => {
    const { container } = renderTranscript();
    const marker = container.querySelector<HTMLElement>('[data-autoscroll-marker]');
    expect(marker).not.toBeNull();
    expect(marker!.style.bottom).toBe('240px');
    expect(marker!.getAttribute('aria-hidden')).toBe('true');
    // Inside the scrolled content, so it moves with it.
    const content = container.querySelector('[data-transcript-scroll] > div');
    expect(content!.contains(marker)).toBe(true);
  });

  it('reports the follow state the last scroll event decided', () => {
    const ref = { current: true };
    const { container } = renderTranscript(ref);
    const scrollEl = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    const marker = container.querySelector<HTMLElement>('[data-autoscroll-marker]')!;

    fireEvent.wheel(scrollEl);
    fakeScroll(scrollEl, { scrollHeight: 2000, clientHeight: 500, scrollTop: 1000 }); // 500 from bottom
    expect(ref.current).toBe(false);
    expect(marker.dataset.following).toBe('false');

    fakeScroll(scrollEl, { scrollHeight: 2000, clientHeight: 500, scrollTop: 1300 }); // 200 from bottom
    expect(ref.current).toBe(true);
    expect(marker.dataset.following).toBe('true');
  });

  // The swap race: a tall row lands in the frame between our scroll-to-bottom
  // and the scroll event it queued, so the event measures the view as far
  // from the bottom. Nobody scrolled; following must survive it.
  it('keeps following through a scroll event the user did not cause', () => {
    const ref = { current: true };
    const { container } = renderTranscript(ref);
    const scrollEl = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    const marker = container.querySelector<HTMLElement>('[data-autoscroll-marker]')!;

    fakeScroll(scrollEl, { scrollHeight: 2600, clientHeight: 500, scrollTop: 1500 }); // 600 from bottom
    expect(ref.current).toBe(true);
    expect(marker.dataset.following).toBe('true');
  });

  it.each([
    ['a key press', (el: HTMLElement) => { fireEvent.keyDown(el, { key: 'PageUp' }); }],
    ['a touch', (el: HTMLElement) => { fireEvent.touchStart(el); }],
    ['a pointer press (scrollbar drag, step buttons)', (el: HTMLElement) => { fireEvent.pointerDown(el); }],
  ])('lets %s turn following off', (_label, act) => {
    const ref = { current: true };
    const { container } = renderTranscript(ref);
    const scrollEl = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;

    act(scrollEl);
    fakeScroll(scrollEl, { scrollHeight: 2000, clientHeight: 500, scrollTop: 1000 });
    expect(ref.current).toBe(false);
  });

  it('forgets user input after a moment, so a later layout jump cannot disengage', () => {
    const now = vi.spyOn(performance, 'now');
    try {
      const ref = { current: true };
      const { container } = renderTranscript(ref);
      const scrollEl = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;

      now.mockReturnValue(1_000);
      fireEvent.wheel(scrollEl);
      now.mockReturnValue(1_000 + USER_SCROLL_INTENT_MS + 1);
      fakeScroll(scrollEl, { scrollHeight: 2600, clientHeight: 500, scrollTop: 1500 });
      expect(ref.current).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  // A scrollbar drag is one pointerdown followed by however long the drag
  // takes; it must count for as long as the button is held.
  it('counts a held pointer as user scrolling for its whole duration', () => {
    const now = vi.spyOn(performance, 'now');
    try {
      const ref = { current: true };
      const { container } = renderTranscript(ref);
      const scrollEl = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;

      now.mockReturnValue(1_000);
      fireEvent.pointerDown(scrollEl);
      now.mockReturnValue(1_000 + USER_SCROLL_INTENT_MS * 5);
      fakeScroll(scrollEl, { scrollHeight: 2600, clientHeight: 500, scrollTop: 1500 });
      expect(ref.current).toBe(false);

      fireEvent.pointerUp(window);
      ref.current = true;
      now.mockReturnValue(1_000 + USER_SCROLL_INTENT_MS * 10);
      fakeScroll(scrollEl, { scrollHeight: 3200, clientHeight: 500, scrollTop: 1500 });
      expect(ref.current).toBe(true);
    } finally {
      now.mockRestore();
    }
  });
});
