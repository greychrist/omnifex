import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useTheme } from "@/hooks";
import { getClaudeSyntaxTheme } from "@/lib/claudeSyntaxTheme";
import { buildMarkdownComponents } from "@/lib/markdownComponents";
import type { AgentMessage } from "@/lib/api";

/**
 * Extracts the `content` string from an `agent_message` notification.
 *
 * Wire shape (from `electron/services/codex/notifications.ts`, Task 7):
 *   { method: "agent_message", params: { content: string } }
 *
 * Defensive — `payload` is typed `unknown` on AgentMessage, and live Codex
 * builds have shipped subtly different params (`text`, no params at all).
 * Returning `""` lets the widget render an empty assistant card rather
 * than crashing the transcript.
 */
function extractContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const params = (payload as { params?: unknown }).params;
  if (!params || typeof params !== "object") return "";
  const content = (params as { content?: unknown; text?: unknown }).content
    ?? (params as { content?: unknown; text?: unknown }).text;
  return typeof content === "string" ? content : "";
}

/**
 * Renders a Codex `agent_message` notification as an assistant card.
 *
 * Mirrors the chrome of Claude's assistant bubble (`InflightAssistantBubble`)
 * so transcripts feel cohesive when a single tab routes through both engines
 * — same Card, same ReactMarkdown pipeline, same syntax theme. The only
 * visible difference is a small "Codex" header with a Bot icon, which acts
 * as the equivalent of the Claude "Assistant" role tag.
 */
export function AgentMessageItem({ message }: { message: AgentMessage }): JSX.Element {
  const content = extractContent(message.payload);
  const { theme } = useTheme();
  const syntaxTheme = useMemo(() => getClaudeSyntaxTheme(theme), [theme]);
  const mdComponents = useMemo(() => buildMarkdownComponents(syntaxTheme), [syntaxTheme]);

  return (
    <Card data-codex-item="agent_message" className="group/card relative my-1 border-border/40">
      <CardContent className="py-2 px-3">
        <div className="flex items-center gap-1.5 mb-1 text-xs text-muted-foreground">
          <Bot className="h-3.5 w-3.5" />
          <span className="font-medium">Codex</span>
        </div>
        <div className="prose prose-sm dark:prose-invert max-w-none break-words">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {content}
          </ReactMarkdown>
        </div>
      </CardContent>
    </Card>
  );
}
