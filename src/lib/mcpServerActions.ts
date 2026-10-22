import type { SessionMcpServerStatus } from '@/lib/api';

export type McpServerAction = 'authenticate' | 'reauthenticate' | 'enable' | 'disable';

/**
 * Row-menu items for an MCP server, mirroring the CLI's /mcp menu.
 * Connectors are detected by config.type 'claudeai-proxy' (verified CLI 2.1.307).
 */
export function mcpServerActions(
  server: SessionMcpServerStatus,
  opts: { canOpenBrowserCallback: boolean },
): McpServerAction[] {
  if (server.status === 'disabled') return ['enable'];

  const type = server.config?.type;
  const actions: McpServerAction[] = [];
  if (opts.canOpenBrowserCallback) {
    const oauthCapable = type === 'http' || type === 'sse' || type === 'claudeai-proxy';
    if (oauthCapable && server.status === 'needs-auth') actions.push('authenticate');
    else if (server.status === 'connected' && (type === 'http' || type === 'sse')) {
      actions.push('reauthenticate');
    }
  }
  actions.push('disable');
  return actions;
}
