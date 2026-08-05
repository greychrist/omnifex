import type { JsonlNode, McpServerConfigError } from '@/types/jsonl';

/**
 * MCP servers the CLI refused to load, read off the session's `system:init`
 * event.
 *
 * Worth knowing about the two failure modes, because only one of them shows
 * up anywhere else: a server with a VALID config that fails to start is
 * listed in `mcp_servers` with `status: 'failed'` and reaches the MCP status
 * panel. A server whose config the CLI rejects is dropped from `mcp_servers`
 * entirely and reported here instead — so if this isn't surfaced, the user's
 * only symptom is a server that silently isn't there.
 *
 * Derived from `messages` rather than captured in the stream reducer for the
 * same reason the context-jump and cache-TTL notices are: the init node stays
 * in the message list, so the notice survives a tab switch or remount instead
 * of living only as long as the state set by one streamed event.
 */

/**
 * Narrow one init event's `mcp_server_errors` to well-formed entries. Returns
 * null for null / empty / all-malformed input, so callers can branch on
 * presence alone rather than on length.
 */
export function parseMcpServerErrors(value: unknown): McpServerConfigError[] | null {
  if (!Array.isArray(value)) return null;
  const out: McpServerConfigError[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { name?: unknown; type?: unknown; message?: unknown };
    // Name is the only field worth insisting on — it's what identifies the
    // server to the user. The rest degrade to sane defaults.
    if (typeof e.name !== 'string' || e.name.length === 0) continue;
    out.push({
      name: e.name,
      type: typeof e.type === 'string' ? e.type : 'unknown',
      message: typeof e.message === 'string' ? e.message : '',
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Scan a session's messages for the most recent init event's skipped-server
 * report. Last init wins: a rebind or restart re-runs the config, so an
 * earlier init's errors may already be fixed.
 */
export function latestMcpServerErrors(
  messages: JsonlNode[],
): McpServerConfigError[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const node = messages[i];
    if (node.kind !== 'cli-stream-init') continue;
    return parseMcpServerErrors(
      (node.raw as { mcp_server_errors?: unknown }).mcp_server_errors,
    );
  }
  return null;
}
