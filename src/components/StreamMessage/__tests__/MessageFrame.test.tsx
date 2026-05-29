// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { MessageFrame } from '@/components/StreamMessage/MessageFrame';
import { MessageRenderingProvider } from '@/contexts/MessageRenderingContext';
import { DEFAULT_CATEGORIES, DEFAULT_OVERRIDES } from '@/lib/messageRenderingConfig';

// Mock api — MessageRenderingProvider calls getSetting on mount. We return a
// v3 config (categories + overrides) so MessageFrame resolves styles through
// resolveKind exactly as it does in production.
vi.mock('@/lib/api', () => ({
  api: {
    getSetting: vi.fn(async () =>
      JSON.stringify({
        version: 3,
        defaultViewMode: 'verbose',
        categories: DEFAULT_CATEGORIES,
        overrides: DEFAULT_OVERRIDES,
        hardFilters: {},
        palette: {},
        typography: {
          header: { typeface: 'inter', size: 'sm', weight: 'semibold', italic: false },
          content: { typeface: 'inter', size: 'sm', weight: 'normal', italic: false },
          icon: { size: 'base', bordered: true, bgOpacity: 100 },
        },
        terminal: { typeface: 'jetbrains-mono', fontSize: 13, cursorStyle: 'block' },
        debug: { showCardKindLabel: false },
      })
    ),
    saveSetting: vi.fn(),
    logWriteBatch: vi.fn(),
  },
}));

describe('MessageFrame', () => {
  afterEach(() => { cleanup(); });

  it('renders MessageFrameCard wrapper when the kind presentation is card', async () => {
    const { container, findByText } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="user.prompt">hi</MessageFrame>
      </MessageRenderingProvider>
    );
    // Wait for the provider's async config load to settle
    await findByText('hi');
    expect(container.querySelector('[data-frame-variant="card"]')).not.toBeNull();
  });

  it('gives right-aligned cards the same width as other cards (no shrink-to-fit)', async () => {
    const { container, findByText } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="user.prompt">right-card-width-probe</MessageFrame>
      </MessageRenderingProvider>
    );
    await findByText('right-card-width-probe');
    // Right alignment is preserved (card chrome hugs the right edge)…
    expect(container.querySelector('[class*="justify-end"]')).not.toBeNull();
    // …but the card is as wide as left-aligned cards, not shrunk to content.
    expect(container.querySelector('[class*="w-[95%]"]')).not.toBeNull();
    expect(container.querySelector('[class*="w-fit"]')).toBeNull();
  });

  it('renders MessageFrameSideLine when the kind presentation is side-line', async () => {
    // user.tool-result resolves to a side-line override.
    const { container, findByText } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="user.tool-result">noise</MessageFrame>
      </MessageRenderingProvider>
    );
    await findByText('noise');
    expect(container.querySelector('[data-testid="side-line-bar"]')).not.toBeNull();
  });

  const sysCtxMsg = { kind: 'user', raw: { type: 'user', message: { content: 'x' } } } as never;

  it('renders the collapsible variant when the kind presentation is collapsible', async () => {
    const { container, findByText } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="user.systemContext" headerOverride="Skill: Foo" message={sysCtxMsg}>
          BODYTEXT
        </MessageFrame>
      </MessageRenderingProvider>
    );
    // The header label is always visible; use it as the settled signal.
    await findByText('Skill: Foo');
    expect(container.querySelector('[data-frame-variant="collapsible"]')).not.toBeNull();
  });

  it('is collapsed by default — body is hidden until expanded', async () => {
    const { queryByText, findByText } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="user.systemContext" headerOverride="Skill: Foo" message={sysCtxMsg}>
          BODYTEXT
        </MessageFrame>
      </MessageRenderingProvider>
    );
    await findByText('Skill: Foo');
    expect(queryByText('BODYTEXT')).toBeNull();
  });

  it('expands the body when the header is clicked', async () => {
    const { findByText, getByText } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="user.systemContext" headerOverride="Skill: Foo" message={sysCtxMsg}>
          BODYTEXT
        </MessageFrame>
      </MessageRenderingProvider>
    );
    const header = await findByText('Skill: Foo');
    fireEvent.click(header);
    expect(getByText('BODYTEXT')).toBeInTheDocument();
  });

  it('renders the forwarded actionBar (copy) in the collapsible header', async () => {
    const { findByText, getByText } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="user.systemContext" headerOverride="Skill: Foo" message={sysCtxMsg} actionBar={<span>COPYSLOT</span>}>
          BODYTEXT
        </MessageFrame>
      </MessageRenderingProvider>
    );
    await findByText('Skill: Foo');
    expect(getByText('COPYSLOT')).toBeInTheDocument();
  });

  it('shows the raw-payload metadata when expanded (showRawPayload kind)', async () => {
    const { findByText, getByText } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="user.systemContext" headerOverride="Skill: Foo" message={sysCtxMsg}>
          BODYTEXT
        </MessageFrame>
      </MessageRenderingProvider>
    );
    const header = await findByText('Skill: Foo');
    fireEvent.click(header);
    expect(getByText('Raw payload')).toBeInTheDocument();
  });

  it('resolves an unseen streamKind to its category style (no unknown fallback)', async () => {
    // An unrecognized dotted id maps to the system category, which renders as
    // a card (not the old dashed side-line "unknown" fallback).
    const { container, findByText } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="not.in.catalog">???</MessageFrame>
      </MessageRenderingProvider>
    );
    await findByText('???');
    expect(container.querySelector('[data-frame-variant="card"]')).not.toBeNull();
  });
});
