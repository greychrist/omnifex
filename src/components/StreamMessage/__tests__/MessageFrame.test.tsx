// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { MessageFrame } from '@/components/StreamMessage/MessageFrame';
import { MessageRenderingProvider, MessageRenderingPreviewProvider } from '@/contexts/MessageRenderingContext';
import { createDefaultConfig, serializeConfig } from '@/lib/messageRenderingConfig';

// Mock api — MessageRenderingProvider calls getSetting on mount. We return a
// v5 config serialized from createDefaultConfig() so MessageFrame resolves
// styles through the registry cascade exactly as it does in production.
vi.mock('@/lib/api', () => ({
  api: {
    getSetting: vi.fn(async () => serializeConfig(createDefaultConfig())),
    saveSetting: vi.fn(),
    logWriteBatch: vi.fn(),
  },
}));

describe('MessageFrame', () => {
  afterEach(() => { cleanup(); });

  // Copy and payload-view were card-only affordances. "What is actually in
  // this record?" is asked most often of the low-weight rows — tool results,
  // bookkeeping, system signals — which are exactly the ones rendered as
  // side-line and collapsible.
  describe('payload affordances on every presentation variant', () => {
    const node = {
      kind: 'system',
      raw: { type: 'system', subtype: 'notification', body: 'b' },
    } as unknown as import('@/types/jsonl').JsonlNode;

    const labelsFor = (container: HTMLElement) =>
      [...container.querySelectorAll('button')]
        .map((b) => b.getAttribute('aria-label'))
        .filter((l): l is string => l === 'Copy content' || l === 'View raw JSON');

    it('gives the side-line variant a copy and a view button', async () => {
      const { container, findByText } = render(
        <MessageRenderingProvider>
          <MessageFrame streamKind="user.tool-result" message={node}>side-line body</MessageFrame>
        </MessageRenderingProvider>
      );
      await findByText('side-line body');
      expect(container.querySelector('[data-frame-variant="side-line"]')).not.toBeNull();
      expect(labelsFor(container)).toEqual(['Copy content', 'View raw JSON']);
    });

    it('gives the collapsible variant a copy and a view button', async () => {
      const { container, findByRole } = render(
        <MessageRenderingProvider>
          <MessageFrame streamKind="user.systemContext" message={node}>collapsed body</MessageFrame>
        </MessageRenderingProvider>
      );
      // The provider loads its config asynchronously; the bar is the thing
      // under test, so wait on that rather than a header label.
      await findByRole('toolbar');
      expect(container.querySelector('[data-frame-variant="collapsible"]')).not.toBeNull();
      expect(labelsFor(container)).toEqual(['Copy content', 'View raw JSON']);
    });

    // The card variant was the one left out: a caller that passed no bar got
    // no buttons at all, which is how the system fallback card lost them.
    it('gives the card variant a copy and a view button', async () => {
      const { container, findByRole } = render(
        <MessageRenderingProvider>
          <MessageFrame streamKind="system.notification.info" message={node}>card body</MessageFrame>
        </MessageRenderingProvider>
      );
      await findByRole('toolbar');
      expect(container.querySelector('[data-frame-variant="card"]')).not.toBeNull();
      expect(labelsFor(container)).toEqual(['Copy content', 'View raw JSON']);
    });

    // Pinned absolutely to the corner, the bar was taller than the header row
    // and hung across its bottom border. Inside the row it centres with it.
    it('seats the card bar inside the header row, not over the corner', async () => {
      const { findByRole } = render(
        <MessageRenderingProvider>
          <MessageFrame streamKind="system.notification.info" message={node}>card body</MessageFrame>
        </MessageRenderingProvider>
      );
      const bar = await findByRole('toolbar');
      expect(bar.closest('[data-card-header]')).not.toBeNull();
      expect(bar.className).not.toMatch(/\babsolute\b/);
    });

    it('leaves a caller-supplied action bar alone', async () => {
      const { container, findByText } = render(
        <MessageRenderingProvider>
          <MessageFrame streamKind="user.tool-result" message={node} actionBar={<span>MINE</span>}>
            side-line body
          </MessageFrame>
        </MessageRenderingProvider>
      );
      await findByText('MINE');
      expect(labelsFor(container)).toEqual([]);
    });
  });

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

  it('narrow-centered cards are indented equally from both sides', () => {
    const config = createDefaultConfig();
    config.kinds = { 'user.prompt': { alignment: 'narrow-center' } };
    const { container } = render(
      <MessageRenderingPreviewProvider config={config}>
        <MessageFrame streamKind="user.prompt">narrow-probe</MessageFrame>
      </MessageRenderingPreviewProvider>
    );
    const row = container.querySelector('[data-frame-variant="card"] > div') as HTMLElement;
    expect(row.className).toContain('justify-center');
    const card = row.firstElementChild as HTMLElement;
    expect(card.className).toContain('w-[80%]');
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
    // user.tool-result resolves to a side-line override — its `$kind` rule only
    // fires when a message is present, so pass one (raw is irrelevant to $kind).
    const { container, findByText } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="user.tool-result" message={{ raw: {} } as never}>noise</MessageFrame>
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
