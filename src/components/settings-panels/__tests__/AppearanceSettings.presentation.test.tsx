// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AppearanceSettings } from '@/components/settings-panels/AppearanceSettings';
import { MessageKindTree } from '@/components/settings-panels/appearance/MessageKindTree';
import { MessageRenderingProvider } from '@/contexts/MessageRenderingContext';
import {
  createDefaultConfig,
} from '@/lib/messageRenderingConfig';

afterEach(() => { cleanup(); });

const saved: { config: unknown } = { config: null };

vi.mock('@/hooks', async (orig) => ({
  ...(await orig<typeof import('@/hooks')>()),
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    getSetting: vi.fn(async () => null),
    saveSetting: vi.fn(async (key: string, value: string) => {
      if (key === 'message_rendering_config_v6') {
        try { saved.config = JSON.parse(value); } catch { /* ignore */ }
      }
    }),
    logWriteBatch: vi.fn(async () => {}),
  },
}));

const noopToast = vi.fn();

function renderWithProvider() {
  return render(
    <MessageRenderingProvider>
      <AppearanceSettings setToast={noopToast} />
    </MessageRenderingProvider>,
  );
}

// Rows are <button>s whose label sits in a flex-1 span.
function clickRow(label: string) {
  const matches = screen.getAllByText(label);
  const rowSpan = matches.find(
    (el) => el.tagName === 'SPAN' && el.className.includes('flex-1') && el.closest('button'),
  );
  const btn = rowSpan ? (rowSpan.closest('button') as HTMLElement) : (matches[0].closest('button') as HTMLElement);
  fireEvent.click(btn);
}

// Categories start collapsed; the tree's own link opens them all.
function expandAll() {
  fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
}

describe('MessageKindTree — registry-driven', () => {
  function renderTree() {
    render(
      <MessageKindTree
        config={createDefaultConfig()}
        selected={{ type: "category", id: "system" }}
        onSelect={() => {}}
      />,
    );
  }

  it('starts with every category collapsed', () => {
    renderTree();
    expect(screen.queryByText("Permission request")).toBeNull();
    expect(screen.queryByText("Permission mode")).toBeNull();
  });

  it('lists registry kinds under their category once expanded', () => {
    renderTree();
    expandAll();
    expect(screen.getByText("Permission request")).toBeInTheDocument();
    expect(screen.getByText("Permission mode")).toBeInTheDocument();
  });

  it('offers Collapse all while any category is open, and Expand all once none is', () => {
    renderTree();
    expect(screen.queryByRole('button', { name: 'Collapse all' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Expand User' }));
    expect(screen.queryByRole('button', { name: 'Expand all' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByText("Tool result")).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument();
  });

  it('lists the four categories', () => {
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
    expect(screen.getByText('Live-only')).toBeInTheDocument();
  });
});

describe('AppearanceSettings — category + kind tree', () => {
  it('lists the three categories', async () => {
    renderWithProvider();
    await screen.findAllByText('User');
    for (const label of ['User', 'Agent', 'System']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expandAll();
    expect(screen.getAllByText('Permission mode').length).toBeGreaterThan(0);
  });


  it('opens a kind editor with a reset affordance when a kind is selected', async () => {
    renderWithProvider();
    await screen.findAllByText('User');
    expandAll();
    clickRow('Permission mode');
    expect(screen.getByRole('button', { name: /reset kind/i })).toBeInTheDocument();
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

    const picker = screen.getByLabelText('User color picker');

    const hexes = ['#111111', '#222222', '#333333', '#444444', '#555555'];
    for (const value of hexes) {
      fireEvent.change(picker, { target: { value } });
    }

    // Synchronously after the burst the debounced commit has not fired.
    const configWrites = () =>
      saveSetting.mock.calls.filter(([key]) => key === 'message_rendering_config_v6').length;
    expect(configWrites()).toBe(0);

    await waitFor(() => expect(configWrites()).toBe(1));
    expect(configWrites()).toBe(1);
    expect(saved.config).not.toBeNull();
    const cfg = saved.config as { categories: Record<string, { accentColor?: string }> };
    expect(cfg.categories.user.accentColor).toBe('#555555');
  });
});

