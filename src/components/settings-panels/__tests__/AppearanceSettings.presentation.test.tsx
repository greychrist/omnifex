// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { AppearanceSettings } from '@/components/settings-panels/AppearanceSettings';
import { MessageRenderingProvider } from '@/contexts/MessageRenderingContext';
import {
  createDefaultConfig,
  pruneRedundantOverrides,
} from '@/lib/messageRenderingConfig';

afterEach(() => { cleanup(); });

// Capture the last config persisted via saveSetting so tests can assert on
// the shape that actually gets written (prune-on-save behaviour).
const saved: { config: unknown } = { config: null };

vi.mock('@/lib/api', () => ({
  api: {
    getSetting: vi.fn(async () => null), // first-load: defaults
    saveSetting: vi.fn(async (key: string, value: string) => {
      if (key === 'message_rendering_config') {
        try { saved.config = JSON.parse(value); } catch { /* ignore */ }
      }
    }),
    logWriteBatch: vi.fn(async () => {}),
  },
}));

// AppearanceSettings requires a setToast prop; provide a no-op.
const noopToast = vi.fn();

function renderWithProvider() {
  return render(
    <MessageRenderingProvider>
      <AppearanceSettings setToast={noopToast} />
    </MessageRenderingProvider>,
  );
}

// Click a row in the tree by its visible label. Rows are <button>s whose
// label sits in a span with the flex-1 class; target that span's button.
function clickRow(label: string) {
  const matches = screen.getAllByText(label);
  const rowSpan = matches.find(
    (el) => el.tagName === 'SPAN' && el.className.includes('flex-1') && el.closest('button'),
  );
  const btn = rowSpan ? (rowSpan.closest('button') as HTMLElement) : (matches[0].closest('button') as HTMLElement);
  fireEvent.click(btn);
}

describe('AppearanceSettings — category + override tree', () => {
  it('lists the five categories and an Overrides section', async () => {
    renderWithProvider();
    await screen.findAllByText('User');
    for (const label of ['User', 'Agent', 'System', 'Attachment', 'Bookkeeping', 'Overrides']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('shows a Presentation dropdown when a category is selected', async () => {
    renderWithProvider();
    await screen.findAllByText('User');
    // User category is selected by default.
    const controls = screen.getAllByLabelText(/^Presentation$/i);
    expect(controls.length).toBeGreaterThan(0);
  });

  it('opens an override editor with a remove affordance when an override is selected', async () => {
    renderWithProvider();
    await screen.findAllByText('User');
    // "Execution complete" is a curated default override (assistant.text.endTurn).
    clickRow('Execution complete');
    expect(screen.getByRole('button', { name: /remove override/i })).toBeInTheDocument();
  });
});

describe('AppearanceSettings — add override', () => {
  it('creates config.overrides[id] for a picked classifier kind id', async () => {
    renderWithProvider();
    await screen.findAllByText('User');
    saved.config = null;

    // Open the Add-override picker.
    fireEvent.click(screen.getByRole('button', { name: /add override/i }));
    // Pick a known classifier id that is NOT already a default override.
    // "assistant.text" has no default override.
    const option = await screen.findByRole('option', { name: /assistant\.text$/ });
    fireEvent.click(option);

    // The override now exists (empty {} = inherits category) in persisted config.
    expect(saved.config).not.toBeNull();
    const cfg = saved.config as { overrides: Record<string, unknown> };
    expect(cfg.overrides['assistant.text']).toBeDefined();
  });
});

describe('pruneRedundantOverrides (prune-on-save)', () => {
  it('removes an override once every field matches its category', () => {
    const cfg = createDefaultConfig();
    cfg.overrides['user.prompt'] = { accentColor: cfg.categories.user.accentColor };
    const cleaned = pruneRedundantOverrides(cfg);
    expect(cleaned.overrides['user.prompt']).toBeUndefined();
  });

  it('keeps an override whose field diverges from its category', () => {
    const cfg = createDefaultConfig();
    cfg.overrides['user.prompt'] = { accentColor: 'pink' };
    const cleaned = pruneRedundantOverrides(cfg);
    expect(cleaned.overrides['user.prompt']).toMatchObject({ accentColor: 'pink' });
  });
});

describe('AppearanceSettings — presentation control', () => {
  it('renders a Border dropdown via the shadcn Select primitive', async () => {
    renderWithProvider();
    await screen.findAllByText('User');
    const border = screen.getAllByLabelText(/^Border$/i)[0];
    expect(border).toBeInTheDocument();
    expect(border.getAttribute('role')).toBe('combobox');
  });

  it('shows inherited placeholders for unset fields in override mode', async () => {
    renderWithProvider();
    await screen.findAllByText('User');
    // "Tool call" (assistant.tool-use) override does not set borderStyle, so it
    // inherits the Agent category. The editor should mark inherited fields.
    clickRow('Tool call');
    const editor = screen.getByTestId('kind-editor');
    expect(within(editor).getAllByText(/inherited/i).length).toBeGreaterThan(0);
  });
});
