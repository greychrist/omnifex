// @vitest-environment jsdom
//
// Guards the fix for the typing lag traced 2026-11-17: the transcript rendered
// every row of every open tab. A 61 MB, 10k-record session drew 1,568 rows
// (45k DOM nodes) and cost WebKit ~600 MB of its 1.27 GB RSS for that one tab;
// the live heap made every GC slow and each streamed record re-rendered
// against all of it, so keystrokes queued behind the work. Rendering a tail
// window took the same tab to 0.68 GB and streaming CPU from 20–30% to 5–12%.
//
// The window is the guard: a long transcript mounts a bounded number of rows,
// and the features that reach older rows (show earlier, find, jumps, scroll
// to top) still reach them.
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import { TRANSCRIPT_WINDOW_ROWS } from '@/lib/transcriptWindow';

vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));
vi.mock('@/contexts/MessageRenderingContext', async () => {
  const { createDefaultConfig } = await import('@/lib/messageRenderingConfig');
  const config = createDefaultConfig();
  return {
    useMessageRenderingConfig: () => ({ config, setConfig: () => {}, loaded: true }),
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
vi.mock('@/components/InflightAssistantBubble', () => ({
  InflightAssistantBubble: () => null,
}));

import { ClaudeTranscript } from '@/components/claude/ClaudeTranscript';
import { TooltipProvider } from '@/components/ui/tooltip-modern';

// jsdom has neither.
beforeAll(() => {
  Element.prototype.scrollTo = vi.fn() as never;
  globalThis.CSS ??= { escape: (s: string) => s } as never;
});
afterEach(() => { cleanup(); });

const ts = (i: number) => new Date(Date.UTC(2026, 10, 17, 0, 0, 0) + i * 1000).toISOString();

const prompt = (i: number): JsonlNode => ({
  kind: 'user',
  userKind: 'prompt',
  sessionId: 's',
  receivedAt: ts(i),
  raw: {
    type: 'user',
    uuid: `u-${i}`,
    timestamp: ts(i),
    message: { role: 'user', content: [{ type: 'text', text: `prompt ${i}` }] },
  } as never,
});

const reply = (i: number): JsonlNode => ({
  kind: 'assistant',
  sessionId: 's',
  receivedAt: ts(i),
  raw: {
    type: 'assistant',
    uuid: `a-${i}`,
    timestamp: ts(i),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `reply ${i}` }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as never,
});

function conversation(turns: number): JsonlNode[] {
  const out: JsonlNode[] = [];
  for (let i = 0; i < turns; i++) out.push(prompt(i * 2), reply(i * 2 + 1));
  return out;
}

type Mode = 'expanded' | 'standard';

function Harness({
  messages,
  viewMode,
  jumpTo = null,
  nearBottom,
}: {
  messages: JsonlNode[];
  viewMode: Mode;
  jumpTo?: { uuid: string; nonce: number } | null;
  nearBottom?: React.MutableRefObject<boolean>;
}) {
  const onResend = React.useRef(() => {}).current;
  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  const ownNearBottom = React.useRef(true);
  return (
    <TooltipProvider>
      <ClaudeTranscript
        messages={messages}
        viewMode={viewMode}
        accountType={undefined}
        onResend={onResend}
        waitingForPermission={false}
        outstandingWork={false}
        hasInflightAssistant={false}
        currentActivity="Thinking"
        contextLimit={200_000}
        error={null}
        tabId="tab-1"
        messagesEndRef={messagesEndRef}
        isNearBottomRef={nearBottom ?? ownNearBottom}
        jumpTo={jumpTo}
      />
    </TooltipProvider>
  );
}

const rowUuids = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-message-uuid]')).map((el) => el.dataset.messageUuid);

// 600 rows' worth of records: four windows, so every mode is well past one.
const LONG = conversation(300);

describe.each(['expanded', 'standard'] as const)('ClaudeTranscript tail window (%s)', (viewMode) => {
  it('mounts at most one window of rows, ending with the newest', () => {
    const { container } = render(<Harness messages={LONG} viewMode={viewMode} />);
    const uuids = rowUuids(container);

    expect(uuids.length).toBeGreaterThan(0);
    expect(uuids.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_ROWS);
    expect(uuids[uuids.length - 1]).toBe('a-599');
    expect(uuids).not.toContain('u-0');
  });

  it('renders a short transcript whole, with no "show earlier" row', () => {
    const { container } = render(<Harness messages={conversation(10)} viewMode={viewMode} />);

    expect(rowUuids(container)).toContain('u-0');
    expect(screen.queryByRole('button', { name: /show earlier/i })).toBeNull();
  });

  it('reveals earlier rows, one window at a time, from the "show earlier" row', () => {
    const { container } = render(<Harness messages={LONG} viewMode={viewMode} />);
    const before = rowUuids(container).length;

    fireEvent.click(screen.getByRole('button', { name: /show earlier/i }));

    const after = rowUuids(container);
    expect(after.length).toBeGreaterThan(before);
    expect(after.length).toBeLessThanOrEqual(before + TRANSCRIPT_WINDOW_ROWS);
  });

  it('renders every row while find is open, so find searches the whole transcript', () => {
    const { container } = render(<Harness messages={LONG} viewMode={viewMode} />);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
    });

    expect(rowUuids(container)).toContain('u-0');
  });

  it('brings an older row into the window when a jump targets it', () => {
    const { container, rerender } = render(<Harness messages={LONG} viewMode={viewMode} />);
    expect(rowUuids(container)).not.toContain('u-0');

    rerender(<Harness messages={LONG} viewMode={viewMode} jumpTo={{ uuid: 'u-0', nonce: 1 }} />);

    expect(rowUuids(container)).toContain('u-0');
  });

  it('renders every row for "scroll to top"', () => {
    const { container } = render(<Harness messages={LONG} viewMode={viewMode} />);

    fireEvent.click(screen.getByRole('button', { name: 'Scroll to top' }));

    expect(rowUuids(container)).toContain('u-0');
  });
});

describe('ClaudeTranscript tail window while reading back', () => {
  it('keeps the rows the reader is looking at when records stream in', () => {
    const nearBottom = { current: true };
    const { container, rerender } = render(
      <Harness messages={LONG} viewMode="expanded" nearBottom={nearBottom} />,
    );
    // Scroll up, away from the tail: following turns off.
    const scroller = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 50_000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 800 });
    scroller.scrollTop = 0;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    expect(nearBottom.current).toBe(false);
    const firstRow = rowUuids(container)[0];

    rerender(
      <Harness messages={[...LONG, prompt(1000), reply(1001), prompt(1002)]} viewMode="expanded" nearBottom={nearBottom} />,
    );

    expect(rowUuids(container)[0]).toBe(firstRow);
    expect(rowUuids(container)).toContain('u-1002');
  });

  it('loads the next window by itself as the reader nears the top', () => {
    const nearBottom = { current: true };
    const { container } = render(
      <Harness messages={LONG} viewMode="expanded" nearBottom={nearBottom} />,
    );
    const before = rowUuids(container).length;
    const scroller = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 50_000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 800 });
    scroller.scrollTop = 100;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);

    expect(rowUuids(container).length).toBeGreaterThan(before);
  });

  it('does not load earlier rows while following the tail', () => {
    const nearBottom = { current: true };
    const { container } = render(
      <Harness messages={LONG} viewMode="expanded" nearBottom={nearBottom} />,
    );
    const before = rowUuids(container).length;
    // A short view: the top is near, but so is the bottom.
    const scroller = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 800 });
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

    expect(rowUuids(container).length).toBe(before);
  });

  // From the bottom, mounting every row grows the content, and a following
  // transcript pins itself to the new bottom — the press snapped straight
  // back down, and landing at the tail collapsed the window again.
  it('stops following for "scroll to top", so the growth does not snap back down', () => {
    const nearBottom = { current: true };
    const { container } = render(
      <Harness messages={LONG} viewMode="expanded" nearBottom={nearBottom} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Scroll to top' }));

    expect(nearBottom.current).toBe(false);
    expect(rowUuids(container)).toContain('u-0');
  });

  // WebKit anchors scrolling: rows mounting above the view move scrollTop to
  // keep what was on screen still, which cancelled a smooth scroll to the top
  // and left the reader at the bottom. The top is set, not animated.
  it('sets the scroll position to the top once every row has mounted', () => {
    const { container } = render(<Harness messages={LONG} viewMode="expanded" />);
    const scroller = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    scroller.scrollTop = 5_000;

    fireEvent.click(screen.getByRole('button', { name: 'Scroll to top' }));

    expect(scroller.scrollTop).toBe(0);
  });

  it('drops back to one window once the reader returns to the tail', () => {
    const nearBottom = { current: true };
    const { container } = render(
      <Harness messages={LONG} viewMode="expanded" nearBottom={nearBottom} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /show earlier/i }));
    expect(rowUuids(container).length).toBeGreaterThan(TRANSCRIPT_WINDOW_ROWS);

    // Back at the bottom: distance 0.
    const scroller = container.querySelector<HTMLElement>('[data-transcript-scroll]')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 50_000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 800 });
    scroller.scrollTop = 49_200;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);

    expect(nearBottom.current).toBe(true);
    expect(rowUuids(container).length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_ROWS);
  });
});
