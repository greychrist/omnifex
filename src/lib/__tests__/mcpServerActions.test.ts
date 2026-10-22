import { describe, it, expect } from 'vitest';
import { mcpServerActions } from '@/lib/mcpServerActions';
import type { SessionMcpServerStatus } from '@/lib/api';

const on = { canOpenBrowserCallback: true };
const mk = (
  status: SessionMcpServerStatus['status'],
  type?: string,
): SessionMcpServerStatus => ({
  name: 's',
  status,
  config: type ? { type } : undefined,
});

describe('mcpServerActions', () => {
  it('disabled stdio -> enable', () => {
    expect(mcpServerActions(mk('disabled', 'stdio'), on)).toEqual(['enable']);
  });
  it('disabled http -> enable', () => {
    expect(mcpServerActions(mk('disabled', 'http'), on)).toEqual(['enable']);
  });
  it('connected stdio -> disable', () => {
    expect(mcpServerActions(mk('connected', 'stdio'), on)).toEqual(['disable']);
  });
  it('connected server with no config type -> disable', () => {
    expect(mcpServerActions(mk('connected'), on)).toEqual(['disable']);
  });
  it('needs-auth http and sse -> authenticate, disable', () => {
    expect(mcpServerActions(mk('needs-auth', 'http'), on)).toEqual(['authenticate', 'disable']);
    expect(mcpServerActions(mk('needs-auth', 'sse'), on)).toEqual(['authenticate', 'disable']);
  });
  it('connected http -> reauthenticate, disable', () => {
    expect(mcpServerActions(mk('connected', 'http'), on)).toEqual(['reauthenticate', 'disable']);
  });
  it('needs-auth claude.ai connector -> authenticate, disable', () => {
    expect(mcpServerActions(mk('needs-auth', 'claudeai-proxy'), on)).toEqual(['authenticate', 'disable']);
  });
  it('connected claude.ai connector -> disable only', () => {
    expect(mcpServerActions(mk('connected', 'claudeai-proxy'), on)).toEqual(['disable']);
  });
  it('failed and pending http -> disable only', () => {
    expect(mcpServerActions(mk('failed', 'http'), on)).toEqual(['disable']);
    expect(mcpServerActions(mk('pending', 'http'), on)).toEqual(['disable']);
  });
  it('no browser callback hides auth items', () => {
    const off = { canOpenBrowserCallback: false };
    expect(mcpServerActions(mk('needs-auth', 'http'), off)).toEqual(['disable']);
    expect(mcpServerActions(mk('connected', 'http'), off)).toEqual(['disable']);
  });
});
