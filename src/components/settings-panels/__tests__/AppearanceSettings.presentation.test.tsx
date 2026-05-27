// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AppearanceSettings } from '@/components/settings-panels/AppearanceSettings';
import { MessageRenderingProvider } from '@/contexts/MessageRenderingContext';

afterEach(() => { cleanup(); });

vi.mock('@/lib/api', () => ({
  api: {
    getSetting: vi.fn(async () => null), // first-load: defaults
    saveSetting: vi.fn(async () => {}),
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

// Helper: click a kind row in the tree by kind label.
// Uses getAllByText and clicks the tree-row button that wraps the span.
// Multiple spans with the same text may exist (SamplePreview, KindEditor
// header, etc.) — we specifically target the span inside a tree-row button.
function clickKindRow(label: string) {
  const spans = screen.getAllByText(label);
  // The tree-row span has class "flex-1 truncate text-xs" and is inside a <button>
  const treeSpan = spans.find(
    (el) => el.tagName === 'SPAN' && el.className.includes('truncate') && el.closest('button'),
  );
  const btn = treeSpan ? (treeSpan.closest('button') as HTMLElement) : spans[0];
  fireEvent.click(btn);
}

describe('AppearanceSettings — presentation control', () => {
  it('shows a Presentation dropdown in each kind editor', async () => {
    renderWithProvider();
    // "User prompt" is selected by default (FIRST_KIND_ID = "user.prompt").
    // Wait for the tree to render, then verify the KindEditor has the control.
    await screen.findAllByText(/User prompt/);
    // getAllByLabelText because both the <label> text and aria-label match.
    const controls = screen.getAllByLabelText(/^Presentation$/i);
    expect(controls.length).toBeGreaterThan(0);
    expect(controls[0]).toBeInTheDocument();
  });

  it('hides Header label when the selected kind defaults to side-line presentation', async () => {
    // Tool result defaults to presentation: 'side-line' in the v2 catalog.
    // Selecting it should hide the card-only Header label control.
    renderWithProvider();
    await screen.findAllByText(/User prompt/);
    // User prompt is the default selection — card presentation, header visible.
    expect(screen.getByLabelText(/^Header label$/i)).toBeInTheDocument();
    // Switch to Tool result (side-line by default).
    clickKindRow('Tool result');
    expect(screen.queryByLabelText(/^Header label$/i)).toBeNull();
  });

  it('renders a Border dropdown via the shadcn Select primitive', async () => {
    renderWithProvider();
    await screen.findAllByText(/User prompt/);
    clickKindRow('Unknown');
    // The shadcn Select trigger is a button with role="combobox".
    const border = screen.getByLabelText(/^Border$/i);
    expect(border).toBeInTheDocument();
    expect(border.getAttribute('role')).toBe('combobox');
  });

  it('exposes the Show raw payload toggle only on the unknown row', async () => {
    renderWithProvider();
    // User prompt is selected by default — no Show raw payload toggle
    await screen.findAllByText(/User prompt/);
    expect(screen.queryByLabelText(/Show raw payload/i)).toBeNull();

    // Switch to Unknown
    clickKindRow('Unknown');
    expect(screen.getByLabelText(/Show raw payload/i)).toBeInTheDocument();
  });
});
