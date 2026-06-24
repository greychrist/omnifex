// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { AppearanceSettings } from '@/components/settings-panels/AppearanceSettings';
import { MessageKindTree } from '@/components/settings-panels/appearance/MessageKindTree';
import { MessageRenderingProvider } from '@/contexts/MessageRenderingContext';
import {
  createDefaultConfig,
} from '@/lib/messageRenderingConfig';

afterEach(() => { cleanup(); });

// Capture the last config persisted via saveSetting so tests can assert on
// the shape that actually gets written.
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

describe('MessageKindTree — registry-driven', () => {
  it('lists registry kinds under their category', () => {
    render(
      <MessageKindTree
        config={createDefaultConfig()}
        selected={{ type: "category", id: "system" }}
        onSelect={() => {}}
      />,
    );
    // system category kinds
    expect(screen.getByText("Permission request")).toBeInTheDocument();
    // agent category kind (still in the tree, just under a different category)
    expect(screen.getByText("Execution complete")).toBeInTheDocument();
  });

  it('lists the three categories', () => {
    render(
      <MessageKindTree
        config={createDefaultConfig()}
        selected={{ type: "category", id: "user" }}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
  });
});

describe('AppearanceSettings — category + kind tree', () => {
  it('lists the three categories', async () => {
    renderWithProvider();
    await screen.findAllByText('User');
    for (const label of ['User', 'Agent', 'System']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    // Registry kinds render under their category
    expect(screen.getAllByText('Tool call').length).toBeGreaterThan(0);
  });

  it('shows a Presentation dropdown when a category is selected', async () => {
    renderWithProvider();
    await screen.findAllByText('User');
    // User category is selected by default.
    const controls = screen.getAllByLabelText(/^Presentation$/i);
    expect(controls.length).toBeGreaterThan(0);
  });

  it('opens a kind editor with a reset affordance when a kind is selected', async () => {
    renderWithProvider();
    await screen.findAllByText('User');
    // "Execution complete" is a kind in the agent category.
    clickRow('Execution complete');
    expect(screen.getByRole('button', { name: /reset to default/i })).toBeInTheDocument();
  });
});

describe('AppearanceSettings — kind field editing', () => {
  it('persists the changed field into config.kinds[id], not inherited category values', async () => {
    // Selecting "Tool call" (assistant.tool-use) opens a kind editor.
    // Toggling "Hide in compact mode" writes only that field into config.kinds[id].
    renderWithProvider();
    await screen.findAllByText('User');
    saved.config = null;

    // Select "Tool call" in the tree.
    clickRow('Tool call');

    // The KindEditor for "Tool call" shows a "Hide in compact mode" switch.
    // assistant.tool-use registry default has hiddenInCompact: true.
    const editor = screen.getByTestId('kind-editor');
    const switches = within(editor).getAllByRole('switch');
    // First switch is always "Hide in compact mode".
    const hiddenSwitch = switches[0];
    expect(hiddenSwitch).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(hiddenSwitch);

    // saveSetting is debounced (the global commit re-renders all chats + writes
    // to disk, so rapid edits coalesce) — wait for the commit to land.
    await waitFor(() => expect(saved.config).not.toBeNull());
    const cfg = saved.config as { kinds: Record<string, Record<string, unknown>> };

    // The kinds map now has an entry for this id.
    expect(cfg.kinds).toBeDefined();
    const patch = cfg.kinds['assistant.tool-use'];
    expect(patch).toBeDefined();

    // hiddenInCompact was written.
    expect(Object.prototype.hasOwnProperty.call(patch, 'hiddenInCompact')).toBe(true);
    expect(patch.hiddenInCompact).toBe(false);

    // Fields not in the patch (inherited) must NOT have been written.
    expect(Object.prototype.hasOwnProperty.call(patch, 'alignment')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(patch, 'presentation')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(patch, 'borderStyle')).toBe(false);
  });
});

describe('AppearanceSettings — edits are debounced before the global commit', () => {
  it('coalesces a rapid burst of color edits into a single persisted commit', async () => {
    const { api } = await import('@/lib/api');
    const saveSetting = vi.mocked(api.saveSetting);

    renderWithProvider();
    await screen.findAllByText('User');

    // Drop the first-load reset write so we count only edit-driven commits.
    saveSetting.mockClear();

    const picker = screen.getByLabelText('Accent colour picker');

    // Simulate an OS color-picker drag: many onChange events in quick
    // succession, like the native <input type="color"> streams.
    const hexes = ['#111111', '#222222', '#333333', '#444444', '#555555'];
    for (const value of hexes) {
      fireEvent.change(picker, { target: { value } });
    }

    // Synchronously after the burst the global commit hasn't fired yet — the
    // whole point: dragging doesn't re-render every chat / write to disk per
    // tick.
    const configWrites = () =>
      saveSetting.mock.calls.filter(([key]) => key === 'message_rendering_config').length;
    expect(configWrites()).toBe(0);

    // After the debounce settles, exactly one commit lands, carrying the LAST
    // value from the burst.
    await waitFor(() => expect(configWrites()).toBe(1));
    expect(configWrites()).toBe(1);
    expect(saved.config).not.toBeNull();
    const cfg = saved.config as { categories: Record<string, { accentColor?: string }> };
    // Default selection is the "user" category; its accentColor took the last edit.
    expect(cfg.categories.user.accentColor).toBe('#555555');
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

  it('shows inherited placeholders for unset fields in kind mode', async () => {
    renderWithProvider();
    await screen.findAllByText('User');
    // Select a kind that has no user patch — inherited fields show "inherited" hint.
    clickRow('Tool call');
    const editor = screen.getByTestId('kind-editor');
    // At least some fields show the inherit hint since no user patch is set.
    expect(within(editor).getAllByText(/inherited/i).length).toBeGreaterThan(0);
  });
});
