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

  it('hides Alignment and Header label when Presentation is set to side-line', async () => {
    renderWithProvider();
    await screen.findAllByText(/User prompt/);
    // Get the native <select> with aria-label="Presentation".
    const presentationSelects = screen.getAllByLabelText(/^Presentation$/i);
    // Pick the <select> element (it has .options)
    const sel = presentationSelects.find((el) => el.tagName === 'SELECT') as HTMLSelectElement | undefined;
    expect(sel).toBeTruthy();
    fireEvent.change(sel!, { target: { value: 'side-line' } });
    expect(screen.queryByLabelText(/^Alignment$/i)).toBeNull();
    expect(screen.queryByLabelText(/^Header label$/i)).toBeNull();
  });

  it('shows a Border dropdown with solid/dashed options', async () => {
    renderWithProvider();
    // "Unknown" kind lives in the "Other" group in the tree
    await screen.findAllByText(/User prompt/); // wait for mount
    clickKindRow('Unknown');
    const border = screen.getByLabelText(/^Border$/i) as HTMLSelectElement;
    expect(border).toBeInTheDocument();
    expect(Array.from(border.options).map((o) => o.value)).toEqual(['solid', 'dashed']);
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
