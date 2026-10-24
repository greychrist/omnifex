import type { SessionMcpServerStatus } from '@/lib/api';

export type McpServerAction = 'authenticate' | 'reauthenticate' | 'reconnect' | 'enable' | 'disable';

/**
 * Row-menu items for an MCP server, mirroring the CLI's /mcp menu.
 * Connectors are detected by config.type 'claudeai-proxy' (verified CLI 2.1.307).
 *
 * `sessionProxied` (CLI 2.1.309) marks an http/sse server whose sign-in the
 * cloud session's MCP proxy holds, so no auth item is offered for it. The CLI
 * sets it on claude.ai connectors too, but mcp_authenticate still answers
 * those with a claude.ai auth URL, so connectors keep Authenticate.
 *
 * Sign-in is offered on every client. One away from the daemon's machine (the
 * iPad) cannot receive the OAuth redirect — it targets the CLI's localhost
 * listener — so the row asks for the URL the browser ended on and hands it to
 * the CLI (`mcp_oauth_callback_url`). That used to hide the items there.
 *
 * Reconnect (`mcp_reconnect`, "a disconnected or failed MCP server") is
 * offered for failed and connected servers, not pending ones: those are
 * already connecting.
 */
export function mcpServerActions(server: SessionMcpServerStatus): McpServerAction[] {
  if (server.status === 'disabled') return ['enable'];

  const type = server.config?.type;
  const actions: McpServerAction[] = [];
  const proxiedHere = server.sessionProxied === true && type !== 'claudeai-proxy';
  if (!proxiedHere) {
    const oauthCapable = type === 'http' || type === 'sse' || type === 'claudeai-proxy';
    if (oauthCapable && server.status === 'needs-auth') actions.push('authenticate');
    else if (server.status === 'connected' && (type === 'http' || type === 'sse')) {
      actions.push('reauthenticate');
    }
  }
  if (server.status === 'failed' || server.status === 'connected') actions.push('reconnect');
  actions.push('disable');
  return actions;
}
