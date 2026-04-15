import type { ClaudeStreamMessage } from "@/components/AgentExecution";

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
  messages: ClaudeStreamMessage[],
  projectPath: string,
): Promise<void> {
  let markdown = `# Claude Code Session\n\n`;
  markdown += `**Project:** ${projectPath}\n`;
  markdown += `**Date:** ${new Date().toISOString()}\n\n`;
  markdown += `---\n\n`;

  for (const msg of messages) {
    if (msg.type === "system" && msg.subtype === "init") {
      markdown += `## System Initialization\n\n`;
      markdown += `- Session ID: \`${msg.session_id || "N/A"}\`\n`;
      markdown += `- Model: \`${msg.model || "default"}\`\n`;
      if (msg.cwd) markdown += `- Working Directory: \`${msg.cwd}\`\n`;
      if (msg.tools?.length) markdown += `- Tools: ${msg.tools.join(", ")}\n`;
      markdown += `\n`;
    } else if (msg.type === "assistant" && msg.message) {
      markdown += `## Assistant\n\n`;
      for (const content of msg.message.content || []) {
        if (content.type === "text") {
          const textContent =
            typeof content.text === "string"
              ? content.text
              : content.text?.text || JSON.stringify(content.text || content);
          markdown += `${textContent}\n\n`;
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
      for (const content of msg.message.content || []) {
        if (content.type === "text") {
          const textContent =
            typeof content.text === "string"
              ? content.text
              : content.text?.text || JSON.stringify(content.text);
          markdown += `${textContent}\n\n`;
        } else if (content.type === "tool_result") {
          markdown += `### Tool Result\n\n`;
          let contentText = "";
          if (typeof content.content === "string") {
            contentText = content.content;
          } else if (
            content.content &&
            typeof content.content === "object"
          ) {
            if (content.content.text) {
              contentText = content.content.text;
            } else if (Array.isArray(content.content)) {
              contentText = content.content
                .map((c: any) =>
                  typeof c === "string" ? c : c.text || JSON.stringify(c),
                )
                .join("\n");
            } else {
              contentText = JSON.stringify(content.content, null, 2);
            }
          }
          markdown += `\`\`\`\n${contentText}\n\`\`\`\n\n`;
        }
      }
    } else if (msg.type === "result") {
      markdown += `## Execution Result\n\n`;
      if (msg.result) {
        markdown += `${msg.result}\n\n`;
      }
      if (msg.error) {
        markdown += `**Error:** ${msg.error}\n\n`;
      }
    }
  }

  await navigator.clipboard.writeText(markdown);
}
