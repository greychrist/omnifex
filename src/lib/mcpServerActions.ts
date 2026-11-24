import type { SessionMcpServerStatus } from '@/lib/api';

export type McpServerAction = 'authenticate' | 'reauthenticate' | 'reconnect' | 'enable' | 'disable';

/**
 * Connectors are `config.type` 'claudeai-proxy' (CLI 2.1.307). The CLI sets `sessionProxied` on them too, but
 * mcp_authenticate still answers them with a claude.ai URL, so they keep Authenticate.
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
