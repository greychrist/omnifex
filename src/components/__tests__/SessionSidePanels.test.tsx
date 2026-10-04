// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import { SessionSidePanels, type SessionSidePanelKey } from '@/components/SessionSidePanels';
import { SessionInspectorPanel } from '@/components/SessionInspectorPanel';

afterEach(() => { cleanup(); localStorage.clear(); });

const content: Record<SessionSidePanelKey, React.ReactNode> = {
  inspector: <div data-testid="body-inspector" />,
  permissions: <div data-testid="body-permissions" />,
  context: <div data-testid="body-context" />,
};

describe('SessionSidePanels', () => {
  it('renders nothing when no panel is open', () => {
    render(<SessionSidePanels open={null} onClose={vi.fn()} content={content} />);
    expect(screen.queryByTestId('resizable-side-panel')).toBeNull();
  });

  it.each<[SessionSidePanelKey, string]>([
    ['inspector', 'Session inspector'],
    ['permissions', 'Permissions'],
    ['context', 'Session context'],
  ])('hosts %s as ONE overlay side panel titled "%s"', (key, title) => {
    render(<SessionSidePanels open={key} onClose={vi.fn()} content={content} />);
    // One panel, the same overlay component the context panel already used —
    // nothing here pushes the transcript aside.
    expect(screen.getAllByTestId('resizable-side-panel')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByTestId(`body-${key}`)).toBeTruthy();
    // Every other panel's body stays unmounted.
    for (const other of Object.keys(content) as SessionSidePanelKey[]) {
      if (other !== key) expect(screen.queryByTestId(`body-${other}`)).toBeNull();
    }
  });

  it('closes through the host header', () => {
    const onClose = vi.fn();
    render(<SessionSidePanels open="context" onClose={onClose} content={content} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Session context' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a panel's header actions only on that panel", () => {
    const actions = { context: <button type="button">Refresh context</button> };
    const { rerender } = render(
      <SessionSidePanels open="context" onClose={vi.fn()} content={content} actions={actions} />,
    );
    expect(screen.getByRole('button', { name: 'Refresh context' })).toBeTruthy();
    rerender(<SessionSidePanels open="permissions" onClose={vi.fn()} content={content} actions={actions} />);
    // The context panel may still be sliding out; look inside the new one.
    const permissions = screen.getByRole('heading', { name: 'Permissions' }).closest('[data-testid="resizable-side-panel"]') as HTMLElement;
    expect(within(permissions).queryByRole('button', { name: 'Refresh context' })).toBeNull();
  });

  it('remembers a width per panel, not one width for all of them', () => {
    const keys = new Set<string>();
    for (const key of Object.keys(content) as SessionSidePanelKey[]) {
      localStorage.clear();
      render(<SessionSidePanels open={key} onClose={vi.fn()} content={content} />);
      fireEvent.doubleClick(screen.getByRole('separator', { name: /resize/i }));
      const [stored] = Object.keys(localStorage);
      expect(stored).toBeTruthy();
      keys.add(stored);
      cleanup();
    }
    expect(keys.size).toBe(3);
  });

  // MCP servers and plugins are sections of Session context now, not panels.
  it('has no MCP or Plugins panel of its own', () => {
    expect(Object.keys(content).sort()).toEqual(['context', 'inspector', 'permissions']);
  });

  it('keeps the context panel width users already saved', () => {
    localStorage.setItem('omnifex.contextLedger.panelWidth', '512');
    render(<SessionSidePanels open="context" onClose={vi.fn()} content={content} />);
    expect(screen.getByTestId('resizable-side-panel').style.width).toBe('512px');
  });
});

describe('SessionInspectorPanel inside the host', () => {
  it('has no header of its own — the host owns the title and the close button', () => {
    render(
      <SessionSidePanels
        open="inspector"
        onClose={vi.fn()}
        content={{
          ...content,
          inspector: (
            <SessionInspectorPanel
              sessionId="abc"
              status="active"
              sessionStatus="started"
              conversationStatus="idle"
              model="opus"
              account={null}
              projectPath="/tmp/x"
              branch={null}
              promptStatus="ready"
              turn={{ status: 'idle', since: null }}
              activeAgents={0}
              tasks={{ total: 0, inProgress: 0, completed: 0, pending: 0 }}
            />
          ),
        }}
      />,
    );
    expect(screen.getAllByRole('button', { name: /^close/i })).toHaveLength(1);
    expect(screen.queryByText(/session inspector/i, { selector: 'span' })).toBeNull();
  });
});
