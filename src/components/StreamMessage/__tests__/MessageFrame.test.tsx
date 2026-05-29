// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { MessageFrame } from '@/components/StreamMessage/MessageFrame';
import { MessageRenderingProvider } from '@/contexts/MessageRenderingContext';

// Mock api — MessageRenderingProvider calls getSetting on mount, then saveSetting +
// logWriteBatch when it resets a pre-v2 config. All three must be present.
vi.mock('@/lib/api', () => ({
  api: {
    getSetting: vi.fn(async () =>
      JSON.stringify({
        version: 2,
        defaultViewMode: 'verbose',
        kinds: {
          'user.prompt': {
            id: 'user.prompt',
            label: 'User prompt',
            description: '',
            origin: 'user',
            icon: 'User',
            headerLabel: 'You',
            accentColor: 'blue',
            alignment: 'right',
            hiddenInCompact: false,
            compactBoundaryLocked: true,
            presentation: 'card',
            borderStyle: 'solid',
          },
          'system.informational': {
            id: 'system.informational',
            label: 'Informational',
            description: '',
            origin: 'system',
            icon: 'Info',
            headerLabel: null,
            accentColor: 'muted',
            alignment: 'left',
            hiddenInCompact: true,
            compactBoundaryLocked: false,
            presentation: 'side-line',
            borderStyle: 'solid',
          },
          'user.systemContext': {
            id: 'user.systemContext',
            label: 'System context',
            description: '',
            origin: 'user',
            icon: 'Sparkles',
            headerLabel: 'System Context',
            accentColor: 'purple',
            alignment: 'left',
            hiddenInCompact: false,
            compactBoundaryLocked: false,
            presentation: 'collapsible',
            borderStyle: 'solid',
            showRawPayload: true,
          },
          unknown: {
            id: 'unknown',
            label: 'Unknown',
            description: '',
            origin: 'fallback',
            icon: 'HelpCircle',
            headerLabel: 'Unknown',
            accentColor: 'orange',
            alignment: 'left',
            hiddenInCompact: false,
            compactBoundaryLocked: false,
            presentation: 'side-line',
            borderStyle: 'dashed',
            showRawPayload: true,
          },
        },
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
    const { container, findByText } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="system.informational">noise</MessageFrame>
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

  it('falls back to the unknown kind when streamKind is not in config', async () => {
    const { container, findByText } = render(
      <MessageRenderingProvider>
        <MessageFrame streamKind="not.in.catalog">???</MessageFrame>
      </MessageRenderingProvider>
    );
    await findByText('???');
    // unknown defaults to side-line presentation with dashed borderStyle
    const bar = container.querySelector('[data-testid="side-line-bar"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('style')).toMatch(/dashed/);
  });
});
