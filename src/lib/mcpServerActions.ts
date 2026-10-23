import type { SessionMcpServerStatus } from '@/lib/api';

export type McpServerAction = 'authenticate' | 'reauthenticate' | 'enable' | 'disable';

/**
 * Row-menu items for an MCP server, mirroring the CLI's /mcp menu.
 * Connectors are detected by config.type 'claudeai-proxy' (verified CLI 2.1.307).
 *
 * `sessionProxied` (CLI 2.1.309) marks an http/sse server whose sign-in the
 * cloud session's MCP proxy holds, so no auth item is offered for it. The CLI
 * sets it on claude.ai connectors too, but mcp_authenticate still answers
 * those with a claude.ai auth URL, so connectors keep Authenticate.
 */
export function mcpServerActions(
  server: SessionMcpServerStatus,
  opts: { canOpenBrowserCallback: boolean },
): McpServerAction[] {
  if (server.status === 'disabled') return ['enable'];

  const type = server.config?.type;
  const actions: McpServerAction[] = [];
  const proxiedHere = server.sessionProxied === true && type !== 'claudeai-proxy';
  if (opts.canOpenBrowserCallback && !proxiedHere) {
    const oauthCapable = type === 'http' || type === 'sse' || type === 'claudeai-proxy';
    if (oauthCapable && server.status === 'needs-auth') actions.push('authenticate');
    else if (server.status === 'connected' && (type === 'http' || type === 'sse')) {
      actions.push('reauthenticate');
    }
  }
  actions.push('disable');
  return actions;
}
