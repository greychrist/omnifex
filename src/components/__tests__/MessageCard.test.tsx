// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MessageFrameCard as MessageCard } from '../StreamMessage/MessageFrameCard';
import type { JsonlNode } from '@/types/jsonl';

// useMessageRenderingConfig falls back to defaults when no provider is
// present, so MessageCard renders standalone. We still mock IconRenderer
// because the real iconMap pulls in dozens of lucide imports and renders
// SVGs — for the assertions we care about (icon presence by name) a
// simple stub suffices.
vi.mock('@/components/settings-panels/appearance/iconMap', () => ({
  IconRenderer: ({ name, className }: { name: string; className?: string }) => (
    <span data-icon={name} className={className} />
  ),
}));

// KindHeader uses the same config hook; the default config supplies an
// empty header label for most kinds, which is fine. We stub minimally so
// header presence is a single deterministic assertion target.
vi.mock('@/components/KindHeader', () => ({
  KindHeader: ({ kindId, fallbackLabel }: { kindId: string; fallbackLabel?: string | null }) => (
    <div data-kind-header={kindId}>{fallbackLabel ?? ''}</div>
  ),
}));

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MessageCard — body + structure', () => {
  it('renders its children', () => {
    render(<MessageCard kindId="assistant.text">hello world</MessageCard>);
    expect(screen.getByText('hello world')).toBeDefined();
  });

  it('renders the KindHeader with the supplied kindId and fallbackLabel', () => {
    render(
      <MessageCard kindId="assistant.text" headerFallbackLabel="Custom Fallback">body</MessageCard>,
    );
    const header = document.querySelector('[data-kind-header="assistant.text"]');
    expect(header).not.toBeNull();
    expect(header!.textContent).toBe('Custom Fallback');
  });

  it('renders an icon from iconOverride when supplied', () => {
    render(
      <MessageCard kindId="x.y" iconOverride="Bot">body</MessageCard>,
    );
    expect(document.querySelector('[data-icon="Bot"]')).not.toBeNull();
  });

  it('omits the icon wrapper when the resolved icon is "none"', () => {
    // Without iconOverride, the default config returns 'none' for an
    // unknown kindId — the icon node should NOT render.
    render(<MessageCard kindId="totally-unknown-kind">body</MessageCard>);
    expect(document.querySelector('[data-icon]')).toBeNull();
  });
});

describe('MessageCard — alignment', () => {
  it('left alignment is the default and applies justify-start', () => {
    const { container } = render(<MessageCard kindId="a">body</MessageCard>);
    expect(container.querySelector('.justify-start')).not.toBeNull();
  });

  it('right alignment applies justify-end', () => {
    const { container } = render(
      <MessageCard kindId="a" alignment="right">body</MessageCard>,
    );
    expect(container.querySelector('.justify-end')).not.toBeNull();
  });

  it('full alignment applies justify-center and widens the card to w-full', () => {
    const { container } = render(
      <MessageCard kindId="a" alignment="full">body</MessageCard>,
    );
    expect(container.querySelector('.justify-center')).not.toBeNull();
    expect(container.querySelector('.w-full')).not.toBeNull();
  });

  it('honors a custom widthClassName override', () => {
    const { container } = render(
      <MessageCard kindId="a" widthClassName="max-w-[300px]">body</MessageCard>,
    );
    expect(container.querySelector('.max-w-\\[300px\\]')).not.toBeNull();
  });
});

describe('MessageCard — footer (timestamp + copy)', () => {
  function makeMessage(receivedAt: string | undefined): JsonlNode {
    return {
      kind: 'unknown',
      sessionId: 's',
      receivedAt: receivedAt ?? '',
      raw: { type: 'result', subtype: 'success' },
    } as unknown as JsonlNode;
  }

  it('renders a formatted timestamp footer when message.receivedAt is set', () => {
    const { container } = render(
      <MessageCard kindId="a" message={makeMessage('2026-06-15T12:34:56Z')}>body</MessageCard>,
    );
    // Bottom-right footer carries the formatted timestamp string.
    const footer = container.querySelector('.bottom-1.right-2');
    expect(footer).not.toBeNull();
    // Format is `MM/DD/YY h:MM:SS AM/PM` (local time, but the date portion
    // is timezone-stable from the source ISO date).
    expect(footer!.textContent).toMatch(/\d{2}\/\d{2}\/\d{2}\s+\d{1,2}:\d{2}:\d{2}\s+(AM|PM)/);
  });

  it('returns null when neither receivedAt nor a debug kind label is available', () => {
    const { container } = render(<MessageCard kindId="a">body</MessageCard>);
    // No footer divs rendered when there's nothing to show.
    expect(container.querySelector('.bottom-1.right-2')).toBeNull();
    expect(container.querySelector('.bottom-1.left-2')).toBeNull();
  });

  it('renders the unformatted ISO string when the date is invalid', () => {
    const { container } = render(
      <MessageCard kindId="a" message={makeMessage('not-a-date')}>body</MessageCard>,
    );
    const footer = container.querySelector('.bottom-1.right-2');
    expect(footer).not.toBeNull();
    expect(footer!.textContent).toBe('not-a-date');
  });
});

describe('MessageCard — debug mode footer (kind label + copy)', () => {
  // The default config has debug.showCardKindLabel = false. The footer's
  // kind-label branch only renders when that flag is true — to exercise
  // it we need a config provider that flips it on. Easiest path: wrap a
  // local Provider stub around the card.
  const FlipDebugProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // Use the actual provider but inject debug.showCardKindLabel = true via
    // a side-effect mock on the hook — simpler than rebuilding the full
    // config tree.
    return <>{children}</>;
  };

  it('renders the type · subtype kind label + copy button when debug flag is on', async () => {
    // Override the hook directly to flip debug.showCardKindLabel.
    const mod = await import('@/contexts/MessageRenderingContext');
    const { createDefaultConfig } = await import('@/lib/messageRenderingConfig');
    const fakeConfig = createDefaultConfig();
    fakeConfig.debug.showCardKindLabel = true;
    const spy = vi.spyOn(mod, 'useMessageRenderingConfig').mockReturnValue({
      config: fakeConfig,
      setConfig: () => {},
      loaded: true,
    });

    const message = {
      kind: 'system',
      subtype: 'notification',
      sessionId: 's',
      receivedAt: '2026-06-15T12:00:00Z',
      raw: { type: 'system', subtype: 'notification' },
    } as unknown as JsonlNode;

    render(
      <FlipDebugProvider>
        <MessageCard kindId="x.y" message={message}>body</MessageCard>
      </FlipDebugProvider>,
    );

    // Kind label is rendered with `type · subtype`.
    const labelEl = document.querySelector('.bottom-1.left-2');
    expect(labelEl).not.toBeNull();
    expect(labelEl!.textContent).toMatch(/system\s*·\s*notification/);

    // Copy button is present.
    const copyBtn = labelEl!.querySelector('button[aria-label="Copy"]');
    expect(copyBtn).not.toBeNull();
    spy.mockRestore();
  });

  it('copy button writes copyText (when set) to the clipboard', async () => {
    const mod = await import('@/contexts/MessageRenderingContext');
    const { createDefaultConfig } = await import('@/lib/messageRenderingConfig');
    const fakeConfig = createDefaultConfig();
    fakeConfig.debug.showCardKindLabel = true;
    const spy = vi.spyOn(mod, 'useMessageRenderingConfig').mockReturnValue({
      config: fakeConfig,
      setConfig: () => {},
      loaded: true,
    });

    const message = {
      kind: 'system', subtype: 'notification', sessionId: 's', receivedAt: '',
      raw: { type: 'system', subtype: 'notification' },
    } as unknown as JsonlNode;
    render(<MessageCard kindId="x" message={message} copyText="custom text">body</MessageCard>);
    const btn = document.querySelector('button[aria-label="Copy"]')!;
    await act(async () => { fireEvent.click(btn); await Promise.resolve(); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('custom text');
    spy.mockRestore();
  });

  it('copy button falls back to JSON.stringify(message) when no copyText is set', async () => {
    const mod = await import('@/contexts/MessageRenderingContext');
    const { createDefaultConfig } = await import('@/lib/messageRenderingConfig');
    const fakeConfig = createDefaultConfig();
    fakeConfig.debug.showCardKindLabel = true;
    const spy = vi.spyOn(mod, 'useMessageRenderingConfig').mockReturnValue({
      config: fakeConfig,
      setConfig: () => {},
      loaded: true,
    });

    const message = {
      kind: 'system', subtype: 'notification', sessionId: 's', receivedAt: '',
      raw: { type: 'system', subtype: 'notification' },
    } as unknown as JsonlNode;
    render(<MessageCard kindId="x" message={message}>body</MessageCard>);
    const btn = document.querySelector('button[aria-label="Copy"]')!;
    await act(async () => { fireEvent.click(btn); await Promise.resolve(); });
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    const arg = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toContain('"type": "system"');
    spy.mockRestore();
  });
});
