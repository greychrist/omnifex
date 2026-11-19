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
  it('has Messages and Turn preview, opening on Messages', () => {
    renderSettings();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Messages', 'Turn preview']);
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
    for (const item of ['Thinking', 'Tool call', 'Assistant text']) {
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

  // A kind's built-in default is what it draws with until you change it, so
  // the editor shows that, not the category it would fall back to.
  it("shows a kind's built-in default, not its category's", () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(within(tree()).getByText('Coordinator message'));
    const editor = screen.getByRole('region', { name: 'Coordinator message settings' });
    expect(within(editor).getByLabelText(/color picker/i)).toHaveValue('#f59e0b');
    expect(within(editor).getByLabelText(/color hex/i)).toHaveAttribute('placeholder', 'Default · #f59e0b');
    expect(within(editor).queryByText(/User's color/)).toBeNull();
    expect(within(editor).getByText(/Hidden by default\./)).toBeInTheDocument();
  });

  it("names the category when a kind has no default of its own", () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(within(tree()).getByText('Tool result'));
    const editor = screen.getByRole('region', { name: 'Tool result settings' });
    expect(within(editor).getByLabelText(/color hex/i).getAttribute('placeholder')).toMatch(/^User's color · #/);
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

  it('previews in Standard and Expanded, following Show in Standard', () => {
    renderSettings();
    const preview = () => screen.getByRole('region', { name: 'Turn preview' });
    // Two lines carry the title: the saved mode record (Permission mode) and
    // the live mode change (its own kind).
    const modeLines = () => within(preview()).queryAllByText('Permission mode').length;
    fireEvent.click(screen.getByRole('tab', { name: 'Turn preview' }));
    const before = modeLines();
    fireEvent.click(screen.getByRole('tab', { name: 'Messages' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(within(tree()).getAllByText('Permission mode')[0]);
    fireEvent.click(screen.getByRole('switch', { name: 'Show in Standard' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Turn preview' }));
    expect(modeLines()).toBe(before - 1);
    fireEvent.click(screen.getByRole('radio', { name: 'Expanded' }));
    expect(modeLines()).toBe(before);
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
describe('Text', () => {
  it('offers the content typeface, size and weight, and no Italic', () => {
    renderSettings();
    fireEvent.click(within(tree()).getByText('Text'));
    expect(screen.getByRole('region', { name: 'Text settings' })).toBeInTheDocument();
    expect(screen.queryByText('Italic')).toBeNull();
  });
});

// The preview is the sample transcript with a record of every kind, so
// Expanded shows them all and Standard shows what the kinds list lets
// through (Greg, 2026-11-19: the old preview showed far more than one turn).
describe('Turn preview — every kind', () => {
  it('draws the sample transcript: every record in Expanded, the shown ones in Standard', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'Turn preview' }));
    const preview = () => screen.getByRole('region', { name: 'Turn preview' });
    const lines = () => preview().querySelectorAll('[data-record-line]').length;
    expect(within(preview()).getByText('Fix the login bug.')).toBeInTheDocument();
    const standard = lines();
    fireEvent.click(screen.getByRole('radio', { name: 'Expanded' }));
    expect(within(preview()).getByText('Unrecognized record: brand_new_record')).toBeInTheDocument();
    expect(lines()).toBeGreaterThan(standard + 20);
  });
});

// One list for everything the chat draws (Greg, 2026-11-19): timeline steps,
// then the message kinds, then the text.
describe('Messages — steps, kinds and text in one list', () => {
  it('lists timeline steps first and Text last', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    const rows = within(tree()).getAllByRole('button').map((b) => b.textContent ?? '');
    const at = (label: string) => rows.findIndex((r) => r.startsWith(label));
    expect(at('Timeline steps')).toBeGreaterThanOrEqual(0);
    expect(at('Command')).toBeGreaterThan(at('Timeline steps'));
    expect(at('Command')).toBeLessThan(at('User'));
    expect(at('Text')).toBe(rows.length - 1);
  });

  it('gives a step an icon and a color, saved on the Modern step settings', async () => {
    renderSettings();
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(within(tree()).getByText('Command'));
    const editor = screen.getByRole('region', { name: 'Command step settings' });
    expect(within(editor).getByRole('button', { name: /icon/i })).toBeInTheDocument();
    expect(within(editor).queryByRole('switch', { name: 'Show in Standard' })).toBeNull();
    fireEvent.change(within(editor).getByLabelText('Command color picker'), { target: { value: '#123456' } });
    await waitFor(() => {
      expect((saved.config as { modern: { stepColors: Record<string, string | null> } } | null)?.modern.stepColors.command).toBe('#123456');
    }, { timeout: 3000 });
  });

  it('lists the answered question, with icon and color but no Show in Standard', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(within(tree()).getByText('Question (answered)'));
    const editor = screen.getByRole('region', { name: 'Question (answered) settings' });
    expect(within(editor).getByLabelText(/color picker/i)).toBeInTheDocument();
    expect(within(editor).queryByRole('switch', { name: 'Show in Standard' })).toBeNull();
  });

  it('puts Font and Answer size under Text, not in the Modern settings', () => {
    renderSettings();
    expect(screen.queryByRole('radiogroup', { name: 'Font' })).toBeNull();
    fireEvent.click(within(tree()).getByText('Text'));
    const editor = screen.getByRole('region', { name: 'Text settings' });
    expect(within(editor).getByRole('radiogroup', { name: 'Font' })).toBeInTheDocument();
    expect(within(editor).getByRole('radiogroup', { name: 'Answer size' })).toBeInTheDocument();
  });
});

// The User prompt chip over a line-style prompt wears this kind's icon; its
// color is Colors › User prompt, so the kind offers the icon alone.
describe('Messages — User prompt kind', () => {
  it('lists User prompt with an icon, and no color or Show in Standard', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(within(tree()).getByText('User prompt'));
    const editor = screen.getByRole('region', { name: 'User prompt settings' });
    expect(within(editor).getByRole('button', { name: /icon/i })).toBeInTheDocument();
    expect(within(editor).queryByLabelText(/color picker/i)).toBeNull();
    expect(within(editor).queryByRole('switch', { name: 'Show in Standard' })).toBeNull();
  });
});
