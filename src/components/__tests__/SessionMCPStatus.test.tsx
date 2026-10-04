// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import type { SessionMcpServerStatus } from '@/lib/api';
import { SessionMCPStatus } from '@/components/SessionMCPStatus';

const server = (name: string, extra: Partial<SessionMcpServerStatus> = {}): SessionMcpServerStatus =>
  ({ name, status: 'connected', scope: 'user', ...extra }) as SessionMcpServerStatus;

const servers = [
  server('brain', { tools: [{ name: 'brain_search' }] } as Partial<SessionMcpServerStatus>),
  server('github', { status: 'failed', error: 'bad auth' }),
];

afterEach(() => { cleanup(); });

describe('SessionMCPStatus', () => {
  it('shows loading while the list is unknown, not "none"', () => {
    render(<SessionMCPStatus servers={null} />);
    expect(screen.queryByText(/no MCP servers/i)).toBeNull();
  });

  it('says when no servers are active', () => {
    render(<SessionMCPStatus servers={[]} />);
    expect(screen.getByText(/no MCP servers active/i)).toBeTruthy();
  });

  it('lists servers under their scope with a count', () => {
    render(<SessionMCPStatus servers={servers} />);
    expect(screen.getByRole('button', { name: /^User\s*2$/ })).toBeTruthy();
    expect(screen.getByText('brain')).toBeTruthy();
  });

  it('says what state each server is in', () => {
    render(<SessionMCPStatus servers={servers} />);
    expect(screen.getByLabelText('failed')).toBeTruthy();
    expect(screen.getByLabelText('connected')).toBeTruthy();
  });

  it('opens a server to show its tools and its error', () => {
    render(<SessionMCPStatus servers={servers} />);
    fireEvent.click(screen.getByRole('button', { name: /brain/ }));
    expect(screen.getByText('brain_search')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /github/ }));
    expect(screen.getByText('bad auth')).toBeTruthy();
  });

  it('collapses a scope group', () => {
    render(<SessionMCPStatus servers={servers} />);
    fireEvent.click(screen.getByRole('button', { name: /^User\s*2$/ }));
    expect(screen.queryByText('brain')).toBeNull();
  });
});
