/**
 * Extract renderable images from a `tool_result` block.
 *
 * Tools that return screenshots — MCP browser/devtools tools, and `Read` on an
 * image file — deliver them as image blocks *nested inside* the tool_result,
 * not as top-level content. OmniFex suppresses tool_results whose tool has a
 * dedicated widget, on the assumption the widget renders the payload; but the
 * widgets render the call, not its images (MCPWidget explicitly discards its
 * `result`). Net effect before this helper existed: screenshots were dropped
 * entirely, leaving only the `assistant.tool-use` entry for the call.
 *
 * Kept as a standalone pure function because two separate layers need the same
 * answer — the visibility filter (`messageFilters.ts`, deciding whether a
 * message is worth showing at all) and the renderer (`StreamMessage.tsx`). If
 * those two disagree, the message is either filtered out before it can render
 * or rendered empty.
 */

export interface ToolResultImage {
  /** Ready for an <img src>. */
  dataUrl: string;
  mediaType: string;
}

/** What the CLI emits when it normalizes to Anthropic's block shape. */
interface AnthropicImageBlock {
  type?: string;
  source?: { type?: string; media_type?: string; data?: string };
}

/** What an MCP server emits natively; some CLI versions pass it through. */
interface McpImageBlock {
  type?: string;
  data?: string;
  mimeType?: string;
}

const DEFAULT_MEDIA_TYPE = 'image/png';

function toImage(block: unknown): ToolResultImage | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as AnthropicImageBlock & McpImageBlock;
  if (b.type !== 'image') return null;

  // Prefer Anthropic's nested `source`, fall back to MCP's flat shape.
  const data = b.source?.data ?? b.data;
  if (typeof data !== 'string' || data.length === 0) return null;

  const mediaType = b.source?.media_type ?? b.mimeType ?? DEFAULT_MEDIA_TYPE;
  // Some producers hand back a complete data URL; re-prefixing yields a broken
  // src that fails silently as a blank image.
  const dataUrl = data.startsWith('data:') ? data : `data:${mediaType};base64,${data}`;

  return { dataUrl, mediaType };
}

export function extractToolResultImages(toolResult: unknown): ToolResultImage[] {
  if (!toolResult || typeof toolResult !== 'object') return [];
  const content = (toolResult as { content?: unknown }).content;
  // A string tool_result is plain text — nothing to extract.
  if (!Array.isArray(content)) return [];

  const images: ToolResultImage[] = [];
  for (const block of content) {
    const image = toImage(block);
    if (image) images.push(image);
  }
  return images;
}

/** True when this tool_result carries at least one renderable image. */
export function toolResultHasImages(toolResult: unknown): boolean {
  return extractToolResultImages(toolResult).length > 0;
}
