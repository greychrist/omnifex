// @vitest-environment jsdom
//
// Settings › Chats after Standard and Expanded (2026-11-18): Messages (the
// Modern settings plus the kinds list), Turn preview, Typography. Per kind:
// icon, color, Show in Standard — nothing else.
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react';
import { AppearanceSettings } from '@/components/settings-panels/AppearanceSettings';
import { MessageRenderingProvider } from '@/contexts/MessageRenderingContext';

afterEach(() => { cleanup(); sessionStorage.clear(); });

vi.mock('@/hooks', async (orig) => ({
  ...(await orig<typeof import('@/hooks')>()),
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

const saved: { config: unknown } = { config: null };
vi.mock('@/lib/api', () => ({
  api: {
    getSetting: vi.fn(async () => null),
    saveSetting: vi.fn(async (key: string, value: string) => {
      if (key === 'message_rendering_config_v6') saved.config = JSON.parse(value);
    }),
    logWriteBatch: vi.fn(async () => {}),
  },
}));

function renderSettings() {
  return render(
    <MessageRenderingProvider>
      <AppearanceSettings setToast={vi.fn()} />
    </MessageRenderingProvider>,
  );
}

const tree = () => screen.getByRole('tree', { name: 'Message kinds' });

describe('Settings › Chats', () => {
  it('has Messages, Turn preview and Typography, in that order, opening on Messages', () => {
    renderSettings();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Messages', 'Turn preview', 'Typography']);
    expect(screen.getByRole('tab', { name: 'Messages' })).toHaveAttribute('aria-selected', 'true');
  });

  it('puts the Modern settings, the card shape and the kinds list on Messages', () => {
    renderSettings();
    expect(screen.getByRole('radiogroup', { name: 'Answer style' })).toBeInTheDocument();
    expect(screen.getByText('Corner radius')).toBeInTheDocument();
    expect(screen.getByText('Border opacity')).toBeInTheDocument();
    expect(tree()).toBeInTheDocument();
  });

  it('lists only kinds whose settings change what is drawn', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    const t = within(tree());
    expect(t.getByText('Permission mode')).toBeInTheDocument();
    for (const item of ['Thinking', 'Tool call', 'User prompt', 'Assistant text']) {
      expect(t.queryByText(item)).toBeNull();
    }
  });

  it('gives a kind exactly an icon, a color and Show in Standard', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(within(tree()).getByText('Permission mode'));
    const editor = screen.getByRole('region', { name: 'Permission mode settings' });
    expect(within(editor).getByRole('button', { name: /icon/i })).toBeInTheDocument();
    expect(within(editor).getByLabelText(/color picker/i)).toBeInTheDocument();
    expect(within(editor).getByRole('switch', { name: 'Show in Standard' })).toBeChecked();
    expect(within(editor).queryByText(/Presentation|Alignment|Border style|Header label/)).toBeNull();
  });

  it('saves Show in Standard on the kind', async () => {
    renderSettings();
    // Let the saved config load first, or it replaces the edit.
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(within(tree()).getByText('Permission mode'));
    fireEvent.click(screen.getByRole('switch', { name: 'Show in Standard' }));
    await waitFor(() => {
      expect((saved.config as { kinds: Record<string, { standard?: boolean }> } | null)?.kinds['permission-mode']?.standard).toBe(false);
    }, { timeout: 3000 });
  });

  it('previews a turn in Standard and Expanded, following Show in Standard', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(within(tree()).getByText('Permission mode'));
    fireEvent.click(screen.getByRole('switch', { name: 'Show in Standard' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Turn preview' }));
    const preview = () => screen.getByRole('region', { name: 'Turn preview' });
    expect(within(preview()).queryByText('Permission mode')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Expanded' }));
    expect(within(preview()).getByText('Permission mode')).toBeInTheDocument();
  });
});

// A v5 Never on thinking or tool calls migrates to hidden in Standard. Those
// kinds are not normally listed, so a hidden one is — or nothing could bring
// it back (review, 2026-11-19).
describe('MessageKindTree — a hidden item kind', () => {
  it('lists Thinking once it is hidden in Standard, so it can be shown again', async () => {
    const { MessageKindTree } = await import('@/components/settings-panels/appearance/MessageKindTree');
    const { createDefaultConfig } = await import('@/lib/messageRenderingConfig');
    const config = createDefaultConfig();
    config.kinds['assistant.thinking'] = { standard: false };
    render(<MessageKindTree config={config} selected={{ type: 'category', id: 'user' }} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(within(tree()).getByText('Thinking')).toBeInTheDocument();
    expect(within(tree()).queryByText('Tool call')).toBeNull();
  });
});

// Every control changes something visible. The chat text is set by CSS
// variables for font, size and weight only; italic reached nothing once the
// classic cards were gone (review, 2026-11-19).
describe('Typography', () => {
  it('offers the content typeface, size and weight, and no Italic', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'Typography' }));
    expect(screen.queryByText('Italic')).toBeNull();
  });
});
