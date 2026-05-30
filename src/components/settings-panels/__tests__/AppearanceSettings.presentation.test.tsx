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
  it('lists the five categories, each grouping its overrides', async () => {
    renderWithProvider();
    await screen.findAllByText('User');
    for (const label of ['User', 'Agent', 'System', 'Attachment', 'Bookkeeping']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    // Default override rules render under their category (e.g. the agent group
    // shows "Tool call" / "Execution complete").
    expect(screen.getAllByText('Tool call').length).toBeGreaterThan(0);
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
  it('creates a new category-scoped rule via the match dialog', async () => {
    renderWithProvider();
    await screen.findAllByText('User');
    saved.config = null;

    // Open the Add-override dialog for the Agent category.
    fireEvent.click(screen.getByRole('button', { name: /add override to agent/i }));
    const dialog = await screen.findByRole('dialog');

    // Author a label, then save.
    const labelInput = within(dialog).getByLabelText('Override label');
    fireEvent.change(labelInput, { target: { value: 'My rule' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add override' }));

    // A new agent-scoped rule with that label is persisted.
    expect(saved.config).not.toBeNull();
    const cfg = saved.config as { overrides: { id: string; label: string; category: string; match: unknown[] }[] };
    const created = cfg.overrides.find((o) => o.label === 'My rule');
    expect(created).toBeDefined();
    expect(created?.category).toBe('agent');
    expect(created?.match).toEqual([]);
  });

  it('seeds a condition by clicking an example JSON field', async () => {
    renderWithProvider();
    await screen.findAllByText('User');

    fireEvent.click(screen.getByRole('button', { name: /add override to system/i }));
    const dialog = await screen.findByRole('dialog');

    // The system example fixture exposes `subtype = "notification"`.
    fireEvent.click(within(dialog).getByTitle('Add: subtype eq "notification"'));
    // A condition row now carries that path.
    const pathInput = within(dialog).getByLabelText('Condition 1 path') as HTMLInputElement;
    expect(pathInput.value).toBe('subtype');
  });
});

describe('AppearanceSettings — single-field override write', () => {
  it('persists only the changed field into the override, not inherited category values', async () => {
    // Regression guard: changing one field on an override must write only that
    // field (plus any already-set fields) into config.overrides[id]. It must
    // NOT copy inherited-from-category values (alignment, presentation,
    // borderStyle, etc.) into the sparse patch.
    //
    // "Tool call" (assistant.tool-use) is a good fixture: it explicitly sets
    // accentColor, icon, headerLabel, and hiddenInCompact in its override —
    // but NOT alignment, presentation, or borderStyle, which are inherited
    // from the agent category. Toggling hiddenInCompact exercises the
    // setOverrideField → mutate → pruneRedundantOverrides write path.
    renderWithProvider();
    await screen.findAllByText('User');
    saved.config = null;

    // Select the "Tool call" override in the tree so the KindEditor shows it.
    clickRow('Tool call');

    // The KindEditor for "Tool call" renders a "Hide in compact mode" switch.
    // "Tool call" has hiddenInCompact: true in its override, so aria-checked is true.
    // Clicking toggles it to false → calls setOverrideField('assistant.tool-use', { hiddenInCompact: false }).
    const editor = screen.getByTestId('kind-editor');
    const switches = within(editor).getAllByRole('switch');
    // The first switch in the editor is always "Hide in compact mode".
    const hiddenSwitch = switches[0];
    expect(hiddenSwitch).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(hiddenSwitch);

    // saveSetting should have been called with the updated config.
    expect(saved.config).not.toBeNull();
    const cfg = saved.config as { overrides: { id: string; style: Record<string, unknown> }[] };
    const rule = cfg.overrides.find((o) => o.id === 'assistant.tool-use');
    expect(rule).toBeDefined();
    const override = rule!.style;

    // The rule's style still exists (accentColor, icon, headerLabel set).
    expect(override).toBeDefined();

    // hiddenInCompact: false matches the agent category default (false), so
    // pruneRedundantOverrides removes it from the sparse patch.
    expect(Object.prototype.hasOwnProperty.call(override, 'hiddenInCompact')).toBe(false);

    // Fields never set on this override must not have been copied from the category.
    // These are the core regression assertions — they guard against the bug where
    // editing one field causes inherited values to bleed into the sparse override.
    expect(Object.prototype.hasOwnProperty.call(override, 'alignment')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(override, 'presentation')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(override, 'borderStyle')).toBe(false);

    // The fields that WERE already in the override are still there.
    expect(override.accentColor).toBe('info');
    expect(override.icon).toBe('Terminal');
    expect(Object.prototype.hasOwnProperty.call(override, 'headerLabel')).toBe(true);
  });
});

describe('pruneRedundantOverrides (prune-on-save)', () => {
  it('drops a style-only rule (no conditions) once every field matches its category', () => {
    const cfg = createDefaultConfig();
    cfg.overrides = [
      { id: 'r1', label: 'r1', category: 'user', match: [], style: { accentColor: cfg.categories.user.accentColor } },
    ];
    const cleaned = pruneRedundantOverrides(cfg);
    expect(cleaned.overrides.find((o) => o.id === 'r1')).toBeUndefined();
  });

  it('keeps a rule whose style field diverges from its category', () => {
    const cfg = createDefaultConfig();
    cfg.overrides = [
      { id: 'r1', label: 'r1', category: 'user', match: [], style: { accentColor: 'pink' } },
    ];
    const cleaned = pruneRedundantOverrides(cfg);
    expect(cleaned.overrides.find((o) => o.id === 'r1')?.style).toMatchObject({ accentColor: 'pink' });
  });

  it('never drops a rule that carries match conditions, even with empty style', () => {
    const cfg = createDefaultConfig();
    cfg.overrides = [
      { id: 'r1', label: 'r1', category: 'system', match: [{ path: 'subtype', op: 'eq', value: 'notification' }], style: {} },
    ];
    const cleaned = pruneRedundantOverrides(cfg);
    expect(cleaned.overrides.find((o) => o.id === 'r1')).toBeDefined();
  });
});

describe('AppearanceSettings — sample preview', () => {
  it('renders the sample through the real MessageFrame', async () => {
    // The preview must look exactly like a rendered message, which means it
    // goes through the same <MessageFrame> the transcript uses. MessageFrame
    // tags every variant with data-frame-variant; a bespoke preview card has
    // no such marker.
    const { container } = renderWithProvider();
    await screen.findAllByText('User');
    expect(container.querySelector('[data-frame-variant]')).not.toBeNull();
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
