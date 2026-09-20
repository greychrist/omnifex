// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { SessionInspectorPanel } from '@/components/SessionInspectorPanel';

afterEach(() => { cleanup(); });

const base = {
  sessionId: 'abc',
  status: 'active' as const,
  sessionStatus: 'started' as const,
  conversationStatus: 'idle' as const,
  model: 'opus',
  account: null,
  projectPath: '/tmp/x',
  branch: null,
  promptStatus: 'ready' as const,
  activeAgents: 0,
  tasks: { total: 0, inProgress: 0, completed: 0, pending: 0 },
};

describe('SessionInspectorPanel — the turn row is the session\'s own axis', () => {
  it('shows an idle turn', () => {
    render(<SessionInspectorPanel {...base} turn={{ status: 'idle', since: null }} />);
    const row = screen.getByTestId('inspector-turn');
    expect(row.textContent).toMatch(/idle/);
    expect(row.textContent).not.toMatch(/since/);
  });

  it('shows a running turn with the instant main opened it', () => {
    render(<SessionInspectorPanel {...base} turn={{ status: 'running', since: '2026-09-20T18:04:05.000Z' }} />);
    const row = screen.getByTestId('inspector-turn');
    expect(row.textContent).toMatch(/running/);
    // The wall-clock the daemon stamped, not a renderer-local flag.
    expect(row.textContent).toMatch(/since/);
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-20T18:04:05.000Z');
  });
});
