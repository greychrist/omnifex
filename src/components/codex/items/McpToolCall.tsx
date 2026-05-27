import { Plug } from "lucide-react";
import type { AgentMessage } from "@/lib/api";

interface McpFields {
  serverName: string;
  toolName: string;
  input: unknown;
  output: unknown;
}

/**
 * Extract server/tool/input/output from an `item.mcp_tool_call`
 * notification.
 *
 * Wire shape (Codex):
 *   { method: "item.mcp_tool_call", params: {
 *       serverName: string,
 *       toolName: string,
 *       input?: unknown,
 *       output?: unknown,
 *   } }
 *
 * Defensive: input/output stay as `unknown` here so the widget can decide
 * how to render each (string vs structured JSON).
 */
function extractMcp(payload: unknown): McpFields {
  const empty: McpFields = {
    serverName: "",
    toolName: "",
    input: undefined,
    output: undefined,
  };
  if (!payload || typeof payload !== "object") return empty;
  const params = (payload as { params?: unknown }).params;
  if (!params || typeof params !== "object") return empty;
  const p = params as {
    serverName?: unknown;
    toolName?: unknown;
    input?: unknown;
    output?: unknown;
  };
  return {
    serverName: typeof p.serverName === "string" ? p.serverName : "",
    toolName: typeof p.toolName === "string" ? p.toolName : "",
    input: p.input,
    output: p.output,
  };
}

/**
 * Pretty-print an unknown JSON-ish value for display. Strings are
 * returned as-is so output strings (which Codex commonly emits raw) don't
 * pick up surrounding JSON quotes. Anything else is `JSON.stringify`'d
 * with indentation; a `JSON.stringify` failure (circular refs, BigInt)
 * falls back to `String(value)`.
 */
function formatJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface CollapsibleJsonProps {
  label: string;
  value: unknown;
}

function CollapsibleJson({ label, value }: CollapsibleJsonProps): JSX.Element | null {
  const text = formatJson(value);
  if (!text) return null;
  return (
    <details className="rounded-md border bg-muted/30 overflow-hidden">
      <summary className="px-3 py-1.5 text-xs font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/50">
        {label}
      </summary>
      <pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap overflow-x-auto bg-background border-t">
        {text}
      </pre>
    </details>
  );
}

/**
 * Renders a Codex `item.mcp_tool_call` notification — an MCP server +
 * tool name header with collapsed input/output JSON underneath. Uses
 * native `<details>` rather than the Radix Collapsible primitive: this
 * widget needs only "click to expand", which `<details>` gives for free
 * without an extra controlled-state hook per call.
 */
export function McpToolCallItem({ message }: { message: AgentMessage }): JSX.Element {
  const { serverName, toolName, input, output } = extractMcp(message.payload);
  const headerLabel =
    serverName && toolName
      ? `${serverName}.${toolName}`
      : serverName || toolName || "(unknown MCP tool)";

  return (
    <div
      data-codex-item="item.mcp_tool_call"
      className="rounded-lg border bg-background overflow-hidden"
    >
      <div className="px-4 py-2 bg-muted/50 flex items-center gap-2 border-b">
        <Plug className="h-3.5 w-3.5 text-purple-500" />
        <span className="text-xs font-mono text-muted-foreground">MCP</span>
        <code className="text-xs font-mono font-medium">{headerLabel}</code>
      </div>
      <div className="p-3 space-y-2">
        <CollapsibleJson label="input" value={input} />
        <CollapsibleJson label="output" value={output} />
      </div>
    </div>
  );
}
