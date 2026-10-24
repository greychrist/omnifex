import { describe, it, expect } from 'vitest';
import { mcpServerActions } from '@/lib/mcpServerActions';
import type { SessionMcpServerStatus } from '@/lib/api';

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
    expect(mcpServerActions(mk('disabled', 'stdio'))).toEqual(['enable']);
  });
  it('disabled http -> enable', () => {
    expect(mcpServerActions(mk('disabled', 'http'))).toEqual(['enable']);
  });
  it('connected stdio -> reconnect, disable', () => {
    expect(mcpServerActions(mk('connected', 'stdio'))).toEqual(['reconnect', 'disable']);
  });
  it('connected server with no config type -> reconnect, disable', () => {
    expect(mcpServerActions(mk('connected'))).toEqual(['reconnect', 'disable']);
  });
  it('needs-auth http and sse -> authenticate, disable', () => {
    expect(mcpServerActions(mk('needs-auth', 'http'))).toEqual(['authenticate', 'disable']);
    expect(mcpServerActions(mk('needs-auth', 'sse'))).toEqual(['authenticate', 'disable']);
  });
  it('connected http -> reauthenticate, disable', () => {
    expect(mcpServerActions(mk('connected', 'http'))).toEqual(['reauthenticate', 'reconnect', 'disable']);
  });
  it('needs-auth claude.ai connector -> authenticate, disable', () => {
    expect(mcpServerActions(mk('needs-auth', 'claudeai-proxy'))).toEqual(['authenticate', 'disable']);
  });
  it('connected claude.ai connector -> reconnect, disable', () => {
    expect(mcpServerActions(mk('connected', 'claudeai-proxy'))).toEqual(['reconnect', 'disable']);
  });
  // mcp_reconnect: "Reconnects a disconnected or failed MCP server" (2.1.310).
  it('failed server -> reconnect, disable', () => {
    expect(mcpServerActions(mk('failed', 'http'))).toEqual(['reconnect', 'disable']);
    expect(mcpServerActions(mk('failed', 'stdio'))).toEqual(['reconnect', 'disable']);
  });
  it('pending server -> disable only (it is already connecting)', () => {
    expect(mcpServerActions(mk('pending', 'http'))).toEqual(['disable']);
  });
  // 2.1.309: an http/sse server reached through the cloud session's MCP proxy
  // has its sign-in held there; mcp_authenticate would start a local OAuth
  // flow against the proxy, so offer none.
  it('session-proxied http server -> disable only', () => {
    const proxied = (status: SessionMcpServerStatus['status']) =>
      ({ ...mk(status, 'http'), sessionProxied: true });
    expect(mcpServerActions(proxied('needs-auth'))).toEqual(['disable']);
    expect(mcpServerActions(proxied('connected'))).toEqual(['reconnect', 'disable']);
  });
  // A claude.ai connector is also sessionProxied on 2.1.309, but
  // mcp_authenticate's connector branch still returns a claude.ai auth URL.
  it('session-proxied claude.ai connector keeps authenticate', () => {
    const s = { ...mk('needs-auth', 'claudeai-proxy'), sessionProxied: true };
    expect(mcpServerActions(s)).toEqual(['authenticate', 'disable']);
  });
  // A client away from the daemon's machine (the iPad) used to get no auth
  // items: the OAuth redirect lands on the CLI's localhost listener, which its
  // browser cannot reach. mcp_oauth_callback_url takes the pasted redirect
  // instead, so sign-in is offered everywhere.
  it('offers sign-in whatever machine the browser is on', () => {
    expect(mcpServerActions(mk('needs-auth', 'http'))).toEqual(['authenticate', 'disable']);
  });
});
