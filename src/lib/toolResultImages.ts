// messageFilters and StreamMessage must agree on this, or a message is filtered out or rendered empty.

export interface ToolResultImage {
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

  const data = b.source?.data ?? b.data;
  if (typeof data !== 'string' || data.length === 0) return null;

  const mediaType = b.source?.media_type ?? b.mimeType ?? DEFAULT_MEDIA_TYPE;
  // Some producers return a full data URL; re-prefixing breaks the src silently.
  const dataUrl = data.startsWith('data:') ? data : `data:${mediaType};base64,${data}`;

  return { dataUrl, mediaType };
}

export function extractToolResultImages(toolResult: unknown): ToolResultImage[] {
  if (!toolResult || typeof toolResult !== 'object') return [];
  const content = (toolResult as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];

  const images: ToolResultImage[] = [];
  for (const block of content) {
    const image = toImage(block);
    if (image) images.push(image);
  }
  return images;
}

export function toolResultHasImages(toolResult: unknown): boolean {
  return extractToolResultImages(toolResult).length > 0;
}
