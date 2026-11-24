import type { JsonlNode, McpServerConfigError } from '@/types/jsonl';

// A server whose config the CLI rejects is dropped from `mcp_servers`; `system:init`'s `mcp_server_errors` is its only trace.

export function parseMcpServerErrors(value: unknown): McpServerConfigError[] | null {
  if (!Array.isArray(value)) return null;
  const out: McpServerConfigError[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { name?: unknown; type?: unknown; message?: unknown };
    if (typeof e.name !== 'string' || e.name.length === 0) continue;
    out.push({
      name: e.name,
      type: typeof e.type === 'string' ? e.type : 'unknown',
      message: typeof e.message === 'string' ? e.message : '',
    });
  }
  return out.length > 0 ? out : null;
}

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
