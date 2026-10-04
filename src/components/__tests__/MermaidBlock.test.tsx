// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const FLOWCHART = readFileSync(
  path.join(__dirname, '../../lib/__tests__/fixtures/mermaid/basic.svg'),
  'utf8',
);

let theme: 'gray' | 'light' = 'gray';
vi.mock('@/hooks', () => ({ useTheme: () => ({ theme, setTheme: () => {}, isLoading: false }) }));

const renderMermaid = vi.fn();
vi.mock('@/lib/mermaid/loadMermaid', () => ({ renderMermaid: (...a: unknown[]) => renderMermaid(...a) }));

const downloadBlob = vi.fn();
const copyPng = vi.fn();
let copyImageAllowed = false;
vi.mock('@/lib/diagramExport', async (orig) => ({
  ...(await orig<typeof import('@/lib/diagramExport')>()),
  downloadBlob: (...a: unknown[]) => downloadBlob(...a),
  copyPng: (...a: unknown[]) => copyPng(...a),
  svgToPng: async () => new Blob(['png'], { type: 'image/png' }),
  canCopyImage: () => copyImageAllowed,
}));

// The pan/zoom library measures layout jsdom does not have; render its
// children straight through and hand back a no-op controller.
vi.mock('react-zoom-pan-pinch', () => ({
  TransformWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TransformComponent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { MermaidBlock } = await import('@/components/diagram/MermaidBlock');

const SRC = 'flowchart LR\n  A --> B';

beforeEach(() => {
  theme = 'gray';
  copyImageAllowed = false;
  renderMermaid.mockReset();
  downloadBlob.mockReset();
  copyPng.mockReset();
});
afterEach(cleanup);

async function renderReady(source = SRC) {
  renderMermaid.mockResolvedValue(FLOWCHART);
  render(<MermaidBlock source={source} />);
  await waitFor(() => { expect(document.querySelector('.omnifex-diagram svg')).not.toBeNull(); });
}

describe('MermaidBlock', () => {
  it('draws the diagram in the app theme', async () => {
    await renderReady();
    expect(renderMermaid).toHaveBeenCalledWith(SRC, 'gray');
    expect(screen.getByRole('button', { name: 'Expand diagram' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download SVG' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download PNG' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy source' })).toBeTruthy();
  });

  it('shows the source and does not render while the reply is streaming', () => {
    render(<MermaidBlock source={SRC} streaming />);
    expect(renderMermaid).not.toHaveBeenCalled();
    expect(screen.getByText(/A --> B/)).toBeTruthy();
    expect(screen.getByText(/draws when the reply finishes/i)).toBeTruthy();
  });

  it('shows mermaid\'s error and the source when the diagram does not parse', async () => {
    renderMermaid.mockRejectedValue(new Error('Parse error on line 2'));
    render(<MermaidBlock source={SRC} />);
    await screen.findByText(/Parse error on line 2/);
    expect(screen.getByText(/A --> B/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy source' })).toBeTruthy();
  });

  it('toggles to the source view', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(document.querySelector('.omnifex-diagram svg')).toBeNull();
    expect(screen.getByText(/A --> B/)).toBeTruthy();
  });

  it('downloads a light-theme SVG even when the app is dark', async () => {
    await renderReady();
    renderMermaid.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Download SVG' }));
    await waitFor(() => { expect(downloadBlob).toHaveBeenCalled(); });
    expect(renderMermaid).toHaveBeenCalledWith(SRC, 'light');
    const [blob, name] = downloadBlob.mock.calls[0] as [Blob, string];
    expect(blob.type).toBe('image/svg+xml');
    expect(name).toMatch(/^diagram-.*\.svg$/);
  });

  it('downloads a PNG', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Download PNG' }));
    await waitFor(() => { expect(downloadBlob).toHaveBeenCalled(); });
    expect((downloadBlob.mock.calls[0] as [Blob, string])[1]).toMatch(/\.png$/);
  });

  it('offers image copy only where the clipboard allows it', async () => {
    await renderReady();
    expect(screen.queryByRole('button', { name: 'Copy image' })).toBeNull();
    cleanup();
    copyImageAllowed = true;
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }));
    await waitFor(() => { expect(copyPng).toHaveBeenCalled(); });
  });

  it('expands into a full-window viewer that Escape closes', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }));
    const dialog = screen.getByRole('dialog', { name: 'Diagram' });
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.querySelector('.omnifex-diagram svg')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Diagram' })).toBeNull();
  });

  it('opens below the app titlebar so its own header and close button stay visible', async () => {
    const titlebar = document.createElement('div');
    titlebar.setAttribute('data-app-drag-region', '');
    titlebar.getBoundingClientRect = () => ({ bottom: 60 } as DOMRect);
    document.body.appendChild(titlebar);
    try {
      await renderReady();
      fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }));
      const dialog = screen.getByRole('dialog', { name: 'Diagram' });
      expect(dialog.style.top).toBe('60px');
      expect(screen.getByRole('button', { name: 'Close diagram' })).toBeTruthy();
    } finally {
      titlebar.remove();
    }
  });

  it('groups the actions into one bar, like the Diagram/Source toggle', async () => {
    await renderReady();
    const bar = screen.getByRole('group', { name: 'Diagram actions' });
    for (const name of ['Download SVG', 'Download PNG', 'Copy source', 'Expand diagram']) {
      expect(bar.contains(screen.getByRole('button', { name }))).toBe(true);
    }
  });

  it('highlights a clicked node in the viewer and clears on the background', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }));
    const dialog = screen.getByRole('dialog', { name: 'Diagram' });
    const svg = dialog.querySelector('.omnifex-diagram svg')!;
    const node = svg.querySelector('g.node[id$="-flowchart-B-1"]')!;

    act(() => {
      fireEvent.pointerDown(node, { clientX: 10, clientY: 10 });
      fireEvent.click(node, { clientX: 10, clientY: 10 });
    });
    expect(svg.hasAttribute('data-highlighting')).toBe(true);
    expect(node.classList.contains('diagram-hl')).toBe(true);

    const canvas = screen.getByTestId('diagram-canvas');
    act(() => {
      fireEvent.pointerDown(canvas, { clientX: 5, clientY: 5 });
      fireEvent.click(canvas, { clientX: 5, clientY: 5 });
    });
    expect(svg.hasAttribute('data-highlighting')).toBe(false);
  });

  it('does not treat the end of a pan as a click', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }));
    const svg = screen.getByRole('dialog', { name: 'Diagram' }).querySelector('.omnifex-diagram svg')!;
    const node = svg.querySelector('g.node[id$="-flowchart-B-1"]')!;
    act(() => {
      fireEvent.pointerDown(node, { clientX: 10, clientY: 10 });
      fireEvent.click(node, { clientX: 60, clientY: 40 });
    });
    expect(svg.hasAttribute('data-highlighting')).toBe(false);
  });
});
