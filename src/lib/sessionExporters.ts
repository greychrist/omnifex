import type { JsonlNode } from "@/types/jsonl";
import type { ClaudeStreamMessage } from "@/types/claudeStream";

/**
 * Copies the raw JSONL output to the clipboard.
 */
export async function exportAsJsonl(rawJsonlOutput: string[]): Promise<void> {
  const jsonl = rawJsonlOutput.join("\n");
  await navigator.clipboard.writeText(jsonl);
}

/**
 * Formats session messages as Markdown and copies to the clipboard.
 */
export async function exportAsMarkdown(
  messages: JsonlNode[],
  projectPath: string,
): Promise<void> {
  let markdown = `# Claude Code Session\n\n`;
  markdown += `**Project:** ${projectPath}\n`;
  markdown += `**Date:** ${new Date().toISOString()}\n\n`;
  markdown += `---\n\n`;

  for (const node of messages) {
    // Use the raw wire shape for markdown rendering — raw IS the ClaudeStreamMessage wire shape.
    const msg = (node as unknown as { raw: ClaudeStreamMessage }).raw;
    if (msg.type === "system" && msg.subtype === "init") {
      // Cast to escape the type-system limitation: TS doesn't narrow the
      // discriminated union past `type+subtype` cleanly when the union has
      // 4+ system variants and one has a branded-string subtype.
      const init = msg as import('@/types/claudeStream').SDKSystemInitMessage;
      markdown += `## System Initialization\n\n`;
      markdown += `- Session ID: \`${init.session_id || "N/A"}\`\n`;
      markdown += `- Model: \`${init.model || "default"}\`\n`;
      if (init.cwd) markdown += `- Working Directory: \`${init.cwd}\`\n`;
      if (init.tools?.length) markdown += `- Tools: ${init.tools.join(", ")}\n`;
      markdown += `\n`;
    } else if (msg.type === "assistant" && msg.message) {
      markdown += `## Assistant\n\n`;
      for (const content of msg.message.content || []) {
        if (content.type === "text") {
          markdown += `${content.text}\n\n`;
        } else if (content.type === "tool_use") {
          markdown += `### Tool: ${content.name}\n\n`;
          markdown += `\`\`\`json\n${JSON.stringify(content.input, null, 2)}\n\`\`\`\n\n`;
        }
      }
      if (msg.message.usage) {
        markdown += `*Tokens: ${msg.message.usage.input_tokens} in, ${msg.message.usage.output_tokens} out*\n\n`;
      }
    } else if (msg.type === "user" && msg.message) {
      markdown += `## User\n\n`;
      // MessageParam.content is string | ContentBlockParam[]; normalise the
      // string form into a single text block so the loop has one shape.
      const userContent = msg.message.content;
      const blocks = typeof userContent === 'string'
        ? [{ type: 'text' as const, text: userContent }]
        : userContent ?? [];
      for (const content of blocks) {
        if (content.type === "text") {
          markdown += `${content.text}\n\n`;
        } else if (content.type === "tool_result") {
          markdown += `### Tool Result\n\n`;
          let contentText = "";
          const inner = content.content;
          if (typeof inner === "string") {
            contentText = inner;
          } else if (Array.isArray(inner)) {
            contentText = inner
              .map((c) =>
                'text' in c && typeof c.text === 'string'
                  ? c.text
                  : JSON.stringify(c),
              )
              .join("\n");
          }
          markdown += `\`\`\`\n${contentText}\n\`\`\`\n\n`;
        }
      }
    } else if (msg.type === "result") {
      markdown += `## Execution Result\n\n`;
      if (msg.subtype === 'success' && msg.result) {
        markdown += `${msg.result}\n\n`;
      }
      // SDKResultError carries `errors: string[]` (the CLI's plural form).
      if (msg.subtype !== 'success') {
        const err = msg as import('@/types/claudeStream').SDKResultErrorMessage;
        if (err.errors?.length) {
          markdown += `**Error:** ${err.errors.join('\n')}\n\n`;
        }
      }
    }
  }

  await navigator.clipboard.writeText(markdown);
}
