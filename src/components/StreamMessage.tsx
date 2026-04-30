import React, { useState, useEffect } from "react";
import {
  Terminal,
  AlertCircle,
  CircleStop,
  Copy,
  Check,
  Sparkles,
  Download,
  RotateCcw,
} from "lucide-react";
import { detectSkillInjection } from "@/lib/skillDetection";
import { classifyStandaloneKind } from "@/lib/messageKind";
import { formatDurationMs } from "@/lib/duration";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { accentStyleFor, swatchFor } from "@/lib/accentStyle";
import { headerLabelFor, iconNameFor } from "@/lib/kindPresentation";
import { contentClassNames, iconSizeClassName, iconWrapperClassName, iconWrapperStyle } from "@/lib/typographyClasses";
import { IconRenderer } from "@/components/settings-panels/appearance/iconMap";
import { KindHeader } from "@/components/KindHeader";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { getClaudeSyntaxTheme } from "@/lib/claudeSyntaxTheme";
import { useTheme } from "@/hooks";
import type { ClaudeStreamMessage } from "@/types/claudeStream";
import {
  TodoWidget,
  TodoReadWidget,
  LSWidget,
  ReadWidget,
  ReadResultWidget,
  GlobWidget,
  BashWidget,
  WriteWidget,
  GrepWidget,
  EditWidget,
  EditResultWidget,
  MCPWidget,
  CommandWidget,
  CommandOutputWidget,
  SummaryWidget,
  MultiEditWidget,
  MultiEditResultWidget,
  SystemReminderWidget,
  TaskWidget,
  LSResultWidget,
  ThinkingWidget,
  WebSearchWidget,
  WebFetchWidget,
  SystemInitializedWidget,
  SystemContextWidget
} from "./ToolWidgets";

/** Extract all meaningful text from a message for copying. */
function extractCopyText(msg: any): string {
  const parts: string[] = [];
  if (msg.content && Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (c.type === 'text' && typeof c.text === 'string') {
        parts.push(c.text);
      } else if (c.type === 'tool_use' && c.input) {
        if (typeof c.input.command === 'string') parts.push(c.input.command);
        else if (typeof c.input.content === 'string') parts.push(c.input.content);
        else if (typeof c.input.pattern === 'string') parts.push(c.input.pattern);
      } else if (c.type === 'tool_result') {
        if (typeof c.content === 'string') parts.push(c.content);
        else if (Array.isArray(c.content)) {
          for (const inner of c.content) {
            if (typeof inner === 'string') parts.push(inner);
            else if (typeof inner.text === 'string') parts.push(inner.text);
          }
        }
      }
    }
  } else if (typeof msg.content === 'string') {
    parts.push(msg.content);
  }
  return parts.join('\n').trim();
}

/** Extract text from a tool_use block + its result for copying. */
function extractToolCopyText(input: any, result: any): string {
  const parts: string[] = [];
  if (input) {
    if (typeof input.command === 'string') parts.push(`$ ${input.command}`);
    if (typeof input.file_path === 'string') parts.push(input.file_path);
    if (typeof input.pattern === 'string') parts.push(input.pattern);
    if (typeof input.content === 'string') parts.push(input.content);
    if (typeof input.query === 'string') parts.push(input.query);
    if (typeof input.url === 'string') parts.push(input.url);
    if (typeof input.prompt === 'string') parts.push(input.prompt);
    if (typeof input.description === 'string') parts.push(input.description);
  }
  if (result) {
    if (typeof result.content === 'string') parts.push(result.content);
    else if (Array.isArray(result.content)) {
      for (const inner of result.content) {
        if (typeof inner === 'string') parts.push(inner);
        else if (typeof inner.text === 'string') parts.push(inner.text);
      }
    }
    if (typeof result.output === 'string') parts.push(result.output);
    if (typeof result.stdout === 'string') parts.push(result.stdout);
  }
  return parts.join('\n').trim();
}

/** Copy button with inline toast feedback. Accepts either a message object or raw text. */
const CopyCardButton: React.FC<{ message?: any; text?: string }> = ({ message, text }) => {
  const [copied, setCopied] = React.useState(false);
  const [toast, setToast] = React.useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const copyText = text ?? (message ? extractCopyText(message) : '');
    if (!copyText) return;
    navigator.clipboard.writeText(copyText);
    setCopied(true);
    setToast(true);
    setTimeout(() => { setCopied(false); setToast(false); }, 2000);
  };

  return (
    <>
      <button
        onClick={handleCopy}
        className="absolute top-1 right-1 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 opacity-0 group-hover/card:opacity-100 transition-opacity z-10"
        title="Copy content"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {toast && (
        <div className="absolute top-1 right-8 z-20 bg-emerald-900/90 text-emerald-100 text-xs px-2 py-1 rounded shadow-lg max-w-[300px] truncate pointer-events-none">
          Copied
        </div>
      )}
    </>
  );
};

/** Image with a hover-reveal download button. */
const DownloadableImage: React.FC<{
  src: string;
  alt: string;
  mediaType?: string;
  className?: string;
}> = ({ src, alt, mediaType, className }) => {
  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    const ext = mediaType
      ? (mediaType.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
      : src.split('.').pop()?.split('?')[0] ?? 'png';
    const filename = `image-${Date.now()}.${ext}`;
    const a = document.createElement('a');
    a.href = src;
    a.download = filename;
    a.click();
  };

  return (
    <div className="relative inline-block group/img">
      <img src={src} alt={alt} className={className} />
      <button
        onClick={handleDownload}
        className="absolute top-1 right-1 p-1 rounded-md bg-background/80 text-muted-foreground hover:text-foreground opacity-0 group-hover/img:opacity-100 transition-opacity z-10"
        title="Download image"
      >
        <Download className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};

/** Copy + optional Resend action bar for user message cards. */
const UserMessageActions: React.FC<{
  msg: any;
  onResend?: (text: string, images?: string[]) => void;
}> = ({ msg, onResend }) => {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const copyText = extractCopyText(msg);
    if (!copyText) return;
    navigator.clipboard.writeText(copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleResend = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onResend) return;
    const content: any[] = Array.isArray(msg.content) ? msg.content : [];
    const text = content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text as string)
      .join('\n');
    const images = content
      .filter((c: any) => c.type === 'image' && c.source?.type === 'base64')
      .map((c: any) => `data:${c.source.media_type};base64,${c.source.data}` as string);
    onResend(text, images.length > 0 ? images : undefined);
  };

  return (
    <div className="absolute top-1 right-1 flex items-center gap-0.5 z-10 opacity-0 group-hover/card:opacity-100 transition-opacity">
      <button
        onClick={handleCopy}
        className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50"
        title="Copy content"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {onResend && (
        <button
          onClick={handleResend}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50"
          title="Resend message"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
};

/** M/D/YY H:MM:SS AM/PM in the user's local timezone. */
function formatLocalTimestamp(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const yy = String(d.getFullYear() % 100).padStart(2, '0');
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const mins = String(d.getMinutes()).padStart(2, '0');
  const secs = String(d.getSeconds()).padStart(2, '0');
  return `${m}/${day}/${yy} ${h}:${mins}:${secs} ${ampm}`;
}

/** Bottom row for a message card: timestamp on the right, optional debug
 *  kind label + copy button on the left. The kind label renders the raw
 *  SDK type (and subtype if present) — gated by the
 *  `debug.showCardKindLabel` flag in Appearance settings. The copy button
 *  writes the full message JSON to the clipboard so the user can inspect
 *  the underlying SDK payload when a card looks mis-classified. Each half
 *  is absent when the underlying message has no data to show. */
const CardTimestamp: React.FC<{
  receivedAt?: string;
  message?: ClaudeStreamMessage;
}> = ({ receivedAt, message }) => {
  const { config } = useMessageRenderingConfig();
  const [copied, setCopied] = useState(false);
  const formatted = receivedAt ? formatLocalTimestamp(receivedAt) : null;

  const showKind = config.debug.showCardKindLabel && message;
  let kindLabel: string | null = null;
  if (showKind) {
    const t = (message as any).type ?? null;
    const sub = (message as any).subtype ?? null;
    if (t) kindLabel = sub ? `${t} · ${sub}` : String(t);
  }

  const handleCopy = async () => {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(message, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      console.error("Failed to copy message:", err);
    }
  };

  if (!formatted && !kindLabel) return null;

  return (
    <>
      {kindLabel && (
        <div
          className="absolute bottom-1 left-2 flex items-center gap-1.5 px-1.5 py-0.5 rounded-md border bg-background text-[10px] text-foreground/80 font-mono select-none"
          title="SDK message type · subtype"
        >
          <span className="pointer-events-none">{kindLabel}</span>
          {message && (
            <button
              type="button"
              onClick={handleCopy}
              className="p-0.5 rounded hover:bg-muted/60 hover:text-foreground transition-colors"
              title={copied ? "Copied!" : "Copy raw message JSON"}
              aria-label="Copy raw message JSON"
            >
              {copied ? (
                <Check className="w-3 h-3 text-green-500" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
            </button>
          )}
        </div>
      )}
      {formatted && (
        <div
          className="absolute bottom-1 right-2 px-1.5 py-0.5 rounded-md border bg-background text-[10px] text-foreground/80 font-mono pointer-events-none select-none"
          title={receivedAt}
        >
          {formatted}
        </div>
      )}
    </>
  );
};

interface StreamMessageProps {
  message: ClaudeStreamMessage;
  className?: string;
  streamMessages: ClaudeStreamMessage[];
  onLinkDetected?: (url: string) => void;
  /** When set, cost is hidden for subscription account types (e.g. "max"). */
  accountType?: string;
  /** Rendered inside an expanded compact group. Nested collapsibles
   *  (ThinkingWidget, etc.) default-expand so the content is visible
   *  without a second click. */
  inExpandedGroup?: boolean;
  /** Called when the user clicks the resend button on a user message card. */
  onResend?: (text: string, images?: string[]) => void;
}

/**
 * Component to render a single Claude Code stream message
 */
const StreamMessageComponent: React.FC<StreamMessageProps> = ({ message, className, streamMessages, onLinkDetected, accountType, inExpandedGroup, onResend }) => {
  // State to track tool results mapped by tool call ID
  const [toolResults, setToolResults] = useState<Map<string, any>>(new Map());
  
  // Get current theme
  const { theme } = useTheme();
  const syntaxTheme = getClaudeSyntaxTheme(theme);

  // Per-kind accent colors, live-reload from Appearance settings
  const { config: renderConfig } = useMessageRenderingConfig();
  
  // Extract all tool results from stream messages
  useEffect(() => {
    const results = new Map<string, any>();
    
    // Iterate through all messages to find tool results
    streamMessages.forEach(msg => {
      if (msg.type === "user" && msg.message?.content && Array.isArray(msg.message.content)) {
        msg.message.content.forEach((content: any) => {
          if (content.type === "tool_result" && content.tool_use_id) {
            results.set(content.tool_use_id, content);
          }
        });
      }
    });
    
    setToolResults(results);
  }, [streamMessages]);
  
  // Helper to get tool result for a specific tool call ID
  const getToolResult = (toolId: string | undefined): any => {
    if (!toolId) return null;
    return toolResults.get(toolId) || null;
  };
  
  try {
    // Skip rendering for meta messages that don't have meaningful content
    if (message.isMeta && !message.leafUuid && !message.summary) {
      return null;
    }

    // Handle summary messages
    if (message.leafUuid && message.summary && (message as any).type === "summary") {
      return <SummaryWidget summary={message.summary} leafUuid={message.leafUuid} />;
    }

    // System initialization message - use the original rich widget
    if (message.type === "system" && message.subtype === "init") {
      return (
        <SystemInitializedWidget
          sessionId={message.session_id}
          model={message.model}
          cwd={message.cwd}
          tools={message.tools}
        />
      );
    }

    // SDK notification — compact inline text styled like the "Pondering..."
    // activity indicator. Color-coded by notification_type:
    //   error → red     ✗
    //   warn  → yellow  ⚠
    //   stop  → red     ⏹ (user-initiated interrupt/cancel)
    //   info  → muted   💬
    if (message.type === "system" && message.subtype === "notification") {
      const notifType = (message as any).notification_type ?? 'info';
      const isError = /error/i.test(notifType);
      const isWarn = /warn/i.test(notifType);
      const isStop = notifType === 'stop';

      const kindId = isError
        ? "system.notification.error"
        : isStop
        ? "system.notification.stop"
        : isWarn
        ? "system.notification.warn"
        : "system.notification.info";
      const swatch = swatchFor(renderConfig, kindId);
      const textStyle: React.CSSProperties = swatch ? { color: swatch } : {};
      const borderStyle: React.CSSProperties = swatch ? { borderColor: swatch } : {};

      const icon = isStop
        ? <CircleStop className="h-3.5 w-3.5 shrink-0" />
        : null;
      const symbol = isError ? '✗' : isWarn ? '⚠' : !isStop ? '💬' : null;

      return (
        <div
          className={cn("flex items-center gap-2 text-xs font-mono py-1.5 px-3 border-l-2", className)}
          style={borderStyle}
        >
          {icon}
          {symbol && <span style={textStyle}>{symbol}</span>}
          <span style={textStyle}>
            {(message as any).title ? `${(message as any).title}: ` : ''}
            {(message as any).message ?? ''}
          </span>
        </div>
      );
    }

    // Assistant message
    if (message.type === "assistant" && message.message) {
      const msg = message.message;

      // If a following result message duplicates this assistant's text content,
      // suppress the duplicated text so only the Execution Complete card shows
      // it. Keep thinking/tool_use blocks visible — otherwise collapsing the
      // whole message hides the reasoning the user explicitly asked to see.
      let suppressTextBlocks = false;
      if (msg.content && Array.isArray(msg.content)) {
        const assistantText = msg.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => typeof c.text === 'string' ? c.text : '')
          .join('');
        if (assistantText) {
          let msgIndex = streamMessages.indexOf(message);
          if (msgIndex === -1) {
            msgIndex = streamMessages.findIndex(
              (m) => m === message || (m.type === message.type && m.message === message.message)
            );
          }
          if (msgIndex !== -1) {
            for (let i = msgIndex + 1; i < Math.min(streamMessages.length, msgIndex + 5); i++) {
              const next = streamMessages[i];
              if (next.type === 'result' && next.result && next.result.trim() === assistantText.trim()) {
                suppressTextBlocks = true;
                break;
              }
            }
          }
          if (suppressTextBlocks) {
            const hasOtherContent = msg.content.some(
              (c: any) => c?.type && c.type !== 'text',
            );
            if (!hasOtherContent) return null;
          }
        }
      }

      let renderedSomething = false;

      const assistantStyle = accentStyleFor(renderConfig, "assistant.text");
      const assistantSwatch = swatchFor(renderConfig, "assistant.text");
      const assistantIconName = iconNameFor(renderConfig, "assistant.text");
      const renderedCard = (
        <div className="flex justify-start">
        <Card
          className={cn("border w-[95%] relative", className)}
          style={assistantStyle}
        >
          <CardContent className="p-4 pb-9">
            <div className="flex items-start gap-3">
              <div
                className={iconWrapperClassName(renderConfig, "assistant.text")}
                style={iconWrapperStyle(renderConfig, assistantSwatch, "assistant.text")}
              >
                <IconRenderer
                  name={assistantIconName ?? "Bot"}
                  className={iconSizeClassName(renderConfig, "assistant.text")}
                />
              </div>
              <div className="flex-1 space-y-2 min-w-0">
                <KindHeader kindId="assistant.text" />
                {msg.content && Array.isArray(msg.content) && msg.content.map((content: any, idx: number) => {
                  // Text content - render as markdown
                  if (content.type === "text") {
                    if (suppressTextBlocks) return null;
                    // Ensure we have a string to render
                    const textContent = typeof content.text === 'string'
                      ? content.text
                      : (content.text?.text || JSON.stringify(content.text || content));

                    renderedSomething = true;
                    return (
                      <div key={idx} className="relative group/card">
                        <CopyCardButton text={textContent} />
                        <div className="prose prose-sm dark:prose-invert max-w-none">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              code({ node, inline, className, children, ...props }: any) {
                                const match = /language-(\w+)/.exec(className || '');
                                return !inline && match ? (
                                  <SyntaxHighlighter
                                    style={syntaxTheme}
                                    language={match[1]}
                                    PreTag="div"
                                    {...props}
                                  >
                                    {String(children).replace(/\n$/, '')}
                                  </SyntaxHighlighter>
                                ) : (
                                  <code className={className} {...props}>
                                    {children}
                                  </code>
                                );
                              }
                            }}
                          >
                            {textContent}
                          </ReactMarkdown>
                        </div>
                      </div>
                    );
                  }

                  // Thinking content - render with ThinkingWidget.
                  // Skip signature-only blocks (SDK returns { thinking: "", signature: "..." }
                  // when showThinkingSummaries is off — there's nothing to display).
                  if (content.type === "thinking") {
                    const thinkingText = typeof content.thinking === 'string' ? content.thinking.trim() : '';
                    if (!thinkingText) return null;
                    renderedSomething = true;
                    return (
                      <div key={idx} className="relative group/card">
                        <CopyCardButton text={thinkingText} />
                        <ThinkingWidget
                          thinking={content.thinking}
                          signature={content.signature}
                          defaultExpanded={inExpandedGroup}
                        />
                      </div>
                    );
                  }
                  
                  // Tool use - render custom widgets based on tool name
                  if (content.type === "tool_use") {
                    const toolName = content.name?.toLowerCase();
                    const input = content.input;
                    const toolId = content.id;
                    
                    // Get the tool result if available
                    const toolResult = getToolResult(toolId);
                    
                    // Function to render the appropriate tool widget
                    const renderToolWidget = () => {
                      // Task tool - for sub-agent tasks
                      if (toolName === "task" && input) {
                        renderedSomething = true;
                        return <TaskWidget description={input.description} prompt={input.prompt} result={toolResult} />;
                      }
                      
                      // Edit tool
                      if (toolName === "edit" && input?.file_path) {
                        renderedSomething = true;
                        return <EditWidget {...input} result={toolResult} />;
                      }
                      
                      // MultiEdit tool
                      if (toolName === "multiedit" && input?.file_path && input?.edits) {
                        renderedSomething = true;
                        return <MultiEditWidget {...input} result={toolResult} />;
                      }
                      
                      // MCP tools (starting with mcp__)
                      if (content.name?.startsWith("mcp__")) {
                        renderedSomething = true;
                        return <MCPWidget toolName={content.name} input={input} result={toolResult} />;
                      }
                      
                      // TodoWrite tool
                      if (toolName === "todowrite" && input?.todos) {
                        renderedSomething = true;
                        return <TodoWidget todos={input.todos} result={toolResult} />;
                      }
                      
                      // TodoRead tool
                      if (toolName === "todoread") {
                        renderedSomething = true;
                        return <TodoReadWidget todos={input?.todos} result={toolResult} />;
                      }
                      
                      // LS tool
                      if (toolName === "ls" && input?.path) {
                        renderedSomething = true;
                        return <LSWidget path={input.path} result={toolResult} />;
                      }
                      
                      // Read tool
                      if (toolName === "read" && input?.file_path) {
                        renderedSomething = true;
                        return <ReadWidget filePath={input.file_path} result={toolResult} />;
                      }
                      
                      // Glob tool
                      if (toolName === "glob" && input?.pattern) {
                        renderedSomething = true;
                        return <GlobWidget pattern={input.pattern} result={toolResult} />;
                      }
                      
                      // Bash tool
                      if (toolName === "bash" && input?.command) {
                        renderedSomething = true;
                        return <BashWidget command={input.command} description={input.description} result={toolResult} />;
                      }
                      
                      // Write tool
                      if (toolName === "write" && input?.file_path && input?.content) {
                        renderedSomething = true;
                        return <WriteWidget filePath={input.file_path} content={input.content} result={toolResult} />;
                      }
                      
                      // Grep tool
                      if (toolName === "grep" && input?.pattern) {
                        renderedSomething = true;
                        return <GrepWidget pattern={input.pattern} include={input.include} path={input.path} exclude={input.exclude} result={toolResult} />;
                      }
                      
                      // WebSearch tool
                      if (toolName === "websearch" && input?.query) {
                        renderedSomething = true;
                        return <WebSearchWidget query={input.query} result={toolResult} />;
                      }
                      
                      // WebFetch tool
                      if (toolName === "webfetch" && input?.url) {
                        renderedSomething = true;
                        return <WebFetchWidget url={input.url} prompt={input.prompt} result={toolResult} />;
                      }
                      
                      // Default - return null
                      return null;
                    };
                    
                    // Render the tool widget
                    const widget = renderToolWidget();
                    if (widget) {
                      renderedSomething = true;
                      const toolText = extractToolCopyText(input, toolResult);
                      return (
                        <div key={idx} className="relative group/card">
                          {toolText && <CopyCardButton text={toolText} />}
                          {widget}
                        </div>
                      );
                    }
                    
                    // Fallback to basic tool display
                    renderedSomething = true;
                    return (
                      <div key={idx} className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Terminal className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm font-medium">
                            Using tool: <code className="font-mono">{content.name}</code>
                          </span>
                        </div>
                        {content.input && (
                          <div className="ml-6 p-2 bg-background rounded-md border">
                            <pre className="text-xs font-mono overflow-x-auto">
                              {JSON.stringify(content.input, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  }
                  
                  return null;
                })}
                
                {msg.usage && (
                  <div className="text-xs text-muted-foreground mt-2">
                    Tokens: {msg.usage.input_tokens} in, {msg.usage.output_tokens} out
                  </div>
                )}
              </div>
            </div>
          </CardContent>
          <CardTimestamp receivedAt={message.receivedAt} message={message} />
        </Card>
        </div>
      );

      if (!renderedSomething) return null;
      return renderedCard;
    }

    // User message - handle both nested and direct content structures
    if (message.type === "user") {
      // Don't render meta messages, which are for system use
      if (message.isMeta) return null;

      // Handle different message structures
      const msg = message.message || message;

      // Check if this is a tool-result-only message first — must happen before
      // bracket-detection to avoid tool results with nested content arrays
      // being misidentified as SDK system messages (the array coerces to
      // "[object Object]" which starts/ends with brackets).
      const isToolResultOnly = Array.isArray(msg.content)
        && msg.content.length > 0
        && msg.content.every((c: any) => c.type === "tool_result");

      // Extract text content, handling nested content arrays from tool results
      const contentStr = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((c: any) => {
              if (typeof c === 'string') return c;
              if (typeof c.text === 'string') return c.text;
              if (typeof c.content === 'string') return c.content;
              // Handle nested content arrays (e.g. tool_result.content = [{ type: "text", text: "..." }])
              if (Array.isArray(c.content)) {
                return c.content.map((inner: any) =>
                  typeof inner === 'string' ? inner : (typeof inner.text === 'string' ? inner.text : '')
                ).join('');
              }
              return '';
            }).join('')
          : '';

      // Detect system-injected context (skills, CLAUDE.md, system-reminders)
      // Render as collapsible widget instead of user message
      if (contentStr.includes('<system-reminder>') || contentStr.includes('Base directory for this skill:')) {
        return <SystemContextWidget content={contentStr} />;
      }

      // SDK-generated bracket messages like "[Request interrupted by user]"
      // or "[Session resumed]" come through as type:'user' but aren't the
      // user's words. Detect them (content is a single string wrapped in
      // square brackets) and render as a system notification so they're
      // visible but visually distinct from the user's actual input.
      // Skip tool-result messages — they are handled below.
      if (!isToolResultOnly) {
        const trimmed = contentStr.trim();
        const isSdkSystemMessage = trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.length < 200;
        if (isSdkSystemMessage) {
          // Strip the brackets and render as an info-level notification
          const inner = trimmed.slice(1, -1);
          const sdkSwatch = swatchFor(renderConfig, "user.sdkSystemBracket");
          const sdkIconName = iconNameFor(renderConfig, "user.sdkSystemBracket") ?? "ℹ";
          const sdkHeader = headerLabelFor(renderConfig, "user.sdkSystemBracket");
          const sdkStyle: React.CSSProperties = sdkSwatch
            ? { borderColor: sdkSwatch, color: sdkSwatch }
            : {};
          return (
            <div
              className={cn(
                "flex items-center gap-2 text-xs font-mono py-1.5 px-3 border-l-2",
                !sdkSwatch && "border-muted-foreground/30",
                className,
              )}
              style={sdkStyle}
            >
              {sdkIconName !== "none" && (
                <span
                  className={sdkSwatch ? "" : "text-muted-foreground"}
                  style={sdkSwatch ? { color: sdkSwatch } : undefined}
                >
                  <IconRenderer name={sdkIconName} className="inline h-3.5 w-3.5" />
                </span>
              )}
              <span
                className={sdkSwatch ? "" : "text-muted-foreground"}
                style={sdkSwatch ? { color: sdkSwatch } : undefined}
              >
                {sdkHeader ? `${sdkHeader}: ${inner}` : inner}
              </span>
            </div>
          );
        }
      }

      // Check if this is a subagent prompt — a user message generated by
      // the Agent tool, not typed interactively. parent_tool_use_id is
      // non-null when the SDK is inside a subagent context. We render
      // these with an amber/yellow tint + Bot icon so they're visually
      // distinct from the user's own purple messages AND from tool results.
      const isSubagentPrompt = !isToolResultOnly
        && message.parent_tool_use_id != null;

      const skillInjection = !isToolResultOnly && !isSubagentPrompt
        ? detectSkillInjection(message, streamMessages)
        : null;

      let renderedSomething = false;

      // Pick card style from the configurable palette. Skill injection is not
      // yet wired through the config (no dedicated kind); keeps its purple tint.
      const userKindId = isToolResultOnly
        ? "tool.result.generic"
        : isSubagentPrompt
        ? "user.subagentPrompt"
        : skillInjection
        ? null
        : "user.prompt";

      const userStyle: React.CSSProperties | undefined = skillInjection
        ? { borderColor: "#a855f755", backgroundColor: "rgba(168, 85, 247, 0.10)" }
        : userKindId
        ? accentStyleFor(renderConfig, userKindId)
        : undefined;
      const userSwatch = skillInjection
        ? "#a855f7"
        : userKindId
        ? swatchFor(renderConfig, userKindId)
        : undefined;

      const cardStyle = {
        className: cn("border", className),
        style: userStyle,
      };

      const userIconName = userKindId ? iconNameFor(renderConfig, userKindId) : null;
      const showUserHeader = !!userKindId && !isToolResultOnly;

      const userKindIdForIcon = userKindId ?? undefined;
      const iconSize = iconSizeClassName(renderConfig, userKindIdForIcon);
      const cardIcon = (
        <div
          className={iconWrapperClassName(renderConfig, userKindIdForIcon)}
          style={iconWrapperStyle(renderConfig, userSwatch, userKindIdForIcon)}
        >
          {isToolResultOnly
            ? <Terminal className={iconSize} />
            : skillInjection
            ? <Sparkles className={iconSize} />
            : (
              <IconRenderer
                name={userIconName ?? (isSubagentPrompt ? "Bot" : "User")}
                className={iconSize}
              />
            )}
        </div>
      );

      const showResend = !!onResend && !isToolResultOnly && !isSubagentPrompt && !skillInjection;

      const renderedCard = (
        <div className={isToolResultOnly ? "" : "flex justify-end"}>
        <Card className={cn(cardStyle.className, !isToolResultOnly && "w-[95%]", "group/card relative")} style={cardStyle.style}>
          {!isToolResultOnly ? (
            <UserMessageActions msg={msg} onResend={showResend ? onResend : undefined} />
          ) : (
            <CopyCardButton message={msg} />
          )}
          <CardContent className="p-4 pb-9">
            <div className="flex items-start gap-3">
              {cardIcon}
              <div className="flex-1 space-y-2 min-w-0">
                {skillInjection && (
                  <div className="text-xs font-medium text-purple-500 dark:text-purple-400 font-mono">
                    Skill: {skillInjection.skillName}
                  </div>
                )}
                {/* Handle content that is a simple string (e.g. from user commands) */}
                {(typeof msg.content === 'string' || (msg.content && !Array.isArray(msg.content))) && (
                  (() => {
                    const contentStr = typeof msg.content === 'string' ? msg.content : String(msg.content);
                    if (contentStr.trim() === '') return null;
                    renderedSomething = true;

                    // Check if it's a command message
                    const commandMatch = contentStr.match(/<command-name>(.+?)<\/command-name>[\s\S]*?<command-message>(.+?)<\/command-message>[\s\S]*?<command-args>(.*?)<\/command-args>/);
                    if (commandMatch) {
                      const [, commandName, commandMessage, commandArgs] = commandMatch;
                      return (
                        <CommandWidget
                          commandName={commandName.trim()}
                          commandMessage={commandMessage.trim()}
                          commandArgs={commandArgs?.trim()}
                        />
                      );
                    }

                    // Check if it's command output
                    const stdoutMatch = contentStr.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
                    if (stdoutMatch) {
                      const [, output] = stdoutMatch;
                      return <CommandOutputWidget output={output} onLinkDetected={onLinkDetected} />;
                    }

                    // Extract @-mentioned image paths and render them inline
                    const imagePathRegex = /@(\/[^\s@]+\.(?:png|jpe?g|gif|webp|svg))/gi;
                    const imagePaths: string[] = [];
                    let textWithoutImages = contentStr;
                    let match;
                    while ((match = imagePathRegex.exec(contentStr)) !== null) {
                      imagePaths.push(match[1]);
                    }
                    textWithoutImages = contentStr.replace(imagePathRegex, '').trim();

                    return (
                      <div>
                        {showUserHeader && userKindId && <KindHeader kindId={userKindId} />}
                        {textWithoutImages && (
                          <div className={cn(contentClassNames(renderConfig), "mb-2")}>
                            {textWithoutImages}
                          </div>
                        )}
                        {imagePaths.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {imagePaths.map((p, i) => (
                              <DownloadableImage
                                key={i}
                                src={`greychrist-file://${encodeURI(p)}`}
                                alt="Pasted image"
                                className="max-w-sm max-h-64 rounded-md border border-border object-contain"
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()
                )}

                {/* Handle content that is an array of parts */}
                {Array.isArray(msg.content) && msg.content.map((content: any, idx: number) => {
                  // Text block
                  if (content.type === "text") {
                    renderedSomething = true;
                    return (
                      <div key={idx}>
                        {showUserHeader && userKindId && <KindHeader kindId={userKindId} />}
                        <div className={cn(contentClassNames(renderConfig), "whitespace-pre-wrap")}>
                          {content.text}
                        </div>
                      </div>
                    );
                  }
                  // Image block (base64)
                  if (content.type === "image" && content.source?.type === "base64") {
                    renderedSomething = true;
                    const dataUrl = `data:${content.source.media_type};base64,${content.source.data}`;
                    return (
                      <DownloadableImage
                        key={idx}
                        src={dataUrl}
                        alt="Pasted image"
                        mediaType={content.source.media_type}
                        className="max-w-sm max-h-64 rounded-md border border-border object-contain"
                      />
                    );
                  }
                  // Tool result
                  if (content.type === "tool_result") {
                    // Skip duplicate tool_result if a dedicated widget is present
                    let hasCorrespondingWidget = false;
                    if (content.tool_use_id && streamMessages) {
                      for (let i = streamMessages.length - 1; i >= 0; i--) {
                        const prevMsg = streamMessages[i];
                        if (prevMsg.type === 'assistant' && prevMsg.message?.content && Array.isArray(prevMsg.message.content)) {
                          const toolUse = prevMsg.message.content.find((c: any) => c.type === 'tool_use' && c.id === content.tool_use_id);
                          if (toolUse) {
                            const toolName = toolUse.name?.toLowerCase();
                            const toolsWithWidgets = ['task','edit','multiedit','todowrite','todoread','ls','read','glob','bash','write','grep','websearch','webfetch'];
                            if (toolsWithWidgets.includes(toolName) || toolUse.name?.startsWith('mcp__')) {
                              hasCorrespondingWidget = true;
                            }
                            break;
                          }
                        }
                      }
                    }

                    if (hasCorrespondingWidget) {
                      return null;
                    }
                    // Extract the actual content string
                    let contentText = '';
                    if (typeof content.content === 'string') {
                      contentText = content.content;
                    } else if (content.content && typeof content.content === 'object') {
                      // Handle object with text property
                      if (content.content.text) {
                        contentText = content.content.text;
                      } else if (Array.isArray(content.content)) {
                        // Handle array of content blocks
                        contentText = content.content
                          .map((c: any) => (typeof c === 'string' ? c : c.text || JSON.stringify(c)))
                          .join('\n');
                      } else {
                        // Fallback to JSON stringify
                        contentText = JSON.stringify(content.content, null, 2);
                      }
                    }
                    
                    // Always show system reminders regardless of widget status
                    const reminderMatch = contentText.match(/<system-reminder>(.*?)<\/system-reminder>/s);
                    if (reminderMatch) {
                      const reminderMessage = reminderMatch[1].trim();
                      const beforeReminder = contentText.substring(0, reminderMatch.index || 0).trim();
                      const afterReminder = contentText.substring((reminderMatch.index || 0) + reminderMatch[0].length).trim();

                      renderedSomething = true;
                      return (
                        <div key={idx} className="space-y-2">
                          <KindHeader kindId="tool.result.generic" fallbackLabel="Tool Result" showIcon />

                          {beforeReminder && (
                            <div className="ml-6 p-2 bg-background rounded-md border">
                              <pre className="text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                                {beforeReminder}
                              </pre>
                            </div>
                          )}
                          
                          <div className="ml-6">
                            <SystemReminderWidget message={reminderMessage} />
                          </div>
                          
                          {afterReminder && (
                            <div className="ml-6 p-2 bg-background rounded-md border">
                              <pre className="text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                                {afterReminder}
                              </pre>
                            </div>
                          )}
                        </div>
                      );
                    }
                    
                    // Check if this is an Edit tool result
                    const isEditResult = contentText.includes("has been updated. Here's the result of running `cat -n`");
                    
                    if (isEditResult) {
                      renderedSomething = true;
                      return (
                        <div key={idx} className="space-y-2">
                          <KindHeader kindId="tool.result.generic" label="Edit Result" showIcon />
                          <EditResultWidget content={contentText} />
                        </div>
                      );
                    }
                    
                    // Check if this is a MultiEdit tool result
                    const isMultiEditResult = contentText.includes("has been updated with multiple edits") || 
                                             contentText.includes("MultiEdit completed successfully") ||
                                             contentText.includes("Applied multiple edits to");
                    
                    if (isMultiEditResult) {
                      renderedSomething = true;
                      return (
                        <div key={idx} className="space-y-2">
                          <KindHeader kindId="tool.result.generic" label="MultiEdit Result" showIcon />
                          <MultiEditResultWidget content={contentText} />
                        </div>
                      );
                    }
                    
                    // Check if this is an LS tool result (directory tree structure)
                    const isLSResult = (() => {
                      if (!content.tool_use_id || typeof contentText !== 'string') return false;
                      
                      // Check if this result came from an LS tool by looking for the tool call
                      let isFromLSTool = false;
                      
                      // Search in previous assistant messages for the matching tool_use
                      if (streamMessages) {
                        for (let i = streamMessages.length - 1; i >= 0; i--) {
                          const prevMsg = streamMessages[i];
                          // Only check assistant messages
                          if (prevMsg.type === 'assistant' && prevMsg.message?.content && Array.isArray(prevMsg.message.content)) {
                            const toolUse = prevMsg.message.content.find((c: any) => 
                              c.type === 'tool_use' && 
                              c.id === content.tool_use_id &&
                              c.name?.toLowerCase() === 'ls'
                            );
                            if (toolUse) {
                              isFromLSTool = true;
                              break;
                            }
                          }
                        }
                      }
                      
                      // Only proceed if this is from an LS tool
                      if (!isFromLSTool) return false;
                      
                      // Additional validation: check for tree structure pattern
                      const lines = contentText.split('\n');
                      const hasTreeStructure = lines.some(line => /^\s*-\s+/.test(line));
                      const hasNoteAtEnd = lines.some(line => line.trim().startsWith('NOTE: do any of the files'));
                      
                      return hasTreeStructure || hasNoteAtEnd;
                    })();
                    
                    if (isLSResult) {
                      renderedSomething = true;
                      return (
                        <div key={idx} className="space-y-2">
                          <KindHeader kindId="tool.result.generic" label="Directory Contents" showIcon />
                          <LSResultWidget content={contentText} />
                        </div>
                      );
                    }
                    
                    // Check if this is a Read tool result (contains line numbers with arrow separator)
                    const isReadResult = content.tool_use_id && typeof contentText === 'string' && 
                      /^\s*\d+→/.test(contentText);
                    
                    if (isReadResult) {
                      // Try to find the corresponding Read tool call to get the file path
                      let filePath: string | undefined;
                      
                      // Search in previous assistant messages for the matching tool_use
                      if (streamMessages) {
                        for (let i = streamMessages.length - 1; i >= 0; i--) {
                          const prevMsg = streamMessages[i];
                          // Only check assistant messages
                          if (prevMsg.type === 'assistant' && prevMsg.message?.content && Array.isArray(prevMsg.message.content)) {
                            const toolUse = prevMsg.message.content.find((c: any) => 
                              c.type === 'tool_use' && 
                              c.id === content.tool_use_id &&
                              c.name?.toLowerCase() === 'read'
                            );
                            if (toolUse?.input?.file_path) {
                              filePath = toolUse.input.file_path;
                              break;
                            }
                          }
                        }
                      }
                      
                      renderedSomething = true;
                      return (
                        <div key={idx} className="space-y-2">
                          <KindHeader kindId="tool.result.generic" label="Read Result" showIcon />
                          <ReadResultWidget content={contentText} filePath={filePath} />
                        </div>
                      );
                    }

                    // Handle empty tool results
                    if (!contentText || contentText.trim() === '') {
                      renderedSomething = true;
                      return (
                        <div key={idx} className="space-y-2">
                          <KindHeader kindId="tool.result.generic" fallbackLabel="Tool Result" showIcon />
                          <div className="ml-6 p-3 bg-muted/50 rounded-md border text-sm text-muted-foreground italic">
                            Tool did not return any output
                          </div>
                        </div>
                      );
                    }

                    renderedSomething = true;
                    return (
                      <div key={idx} className="space-y-2">
                        {content.is_error
                          ? <KindHeader kindId="result.error" label="Tool Error" fallbackIcon="AlertCircle" showIcon />
                          : <KindHeader kindId="tool.result.generic" fallbackLabel="Tool Result" showIcon />}
                        <div className="ml-6 p-2 bg-background rounded-md border">
                          <pre className="text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                            {contentText}
                          </pre>
                        </div>
                      </div>
                    );
                  }

                  return null;
                })}
              </div>
            </div>
          </CardContent>
          <CardTimestamp receivedAt={message.receivedAt} message={message} />
        </Card>
        </div>
      );
      if (!renderedSomething) return null;
      return renderedCard;
    }

    // Result message - render with markdown
    if (message.type === "result") {
      const classifiedKind = classifyStandaloneKind(message, streamMessages);
      const resultKindId =
        classifiedKind === "result.error"
          || classifiedKind === "result.awaiting_background"
          || classifiedKind === "result.success"
          ? classifiedKind
          : (message.is_error || message.subtype?.includes("error")
              ? "result.error"
              : "result.success");
      const isError = resultKindId === "result.error";
      const isAwaiting = resultKindId === "result.awaiting_background";
      const resultStyle = accentStyleFor(renderConfig, resultKindId);
      const resultSwatch = swatchFor(renderConfig, resultKindId);
      const resultIconName = iconNameFor(renderConfig, resultKindId)
        ?? (isError ? "AlertCircle" : isAwaiting ? "Hourglass" : "CheckCircle2");
      const resultFallbackLabel = isError
        ? "Execution Failed"
        : isAwaiting
          ? "Awaiting Background Work"
          : "Execution Complete";

      return (
        <Card className={cn("border relative", className)} style={resultStyle}>
          <CardContent className="p-4 pb-9">
            <div className="flex items-start gap-3">
              <div
                className={iconWrapperClassName(renderConfig, resultKindId)}
                style={iconWrapperStyle(renderConfig, resultSwatch, resultKindId)}
              >
                <IconRenderer name={resultIconName} className={iconSizeClassName(renderConfig, resultKindId)} />
              </div>
              <div className="flex-1 space-y-2">
                <KindHeader kindId={resultKindId} fallbackLabel={resultFallbackLabel} />

                {message.result && (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        code({ node, inline, className, children, ...props }: any) {
                          const match = /language-(\w+)/.exec(className || '');
                          return !inline && match ? (
                            <SyntaxHighlighter
                              style={syntaxTheme}
                              language={match[1]}
                              PreTag="div"
                              {...props}
                            >
                              {String(children).replace(/\n$/, '')}
                            </SyntaxHighlighter>
                          ) : (
                            <code className={className} {...props}>
                              {children}
                            </code>
                          );
                        }
                      }}
                    >
                      {message.result}
                    </ReactMarkdown>
                  </div>
                )}

                {message.error && (
                  <div className="text-sm text-destructive">{message.error}</div>
                )}

                <hr className="border-t border-border/50 my-2" />
                <div className="text-xs text-muted-foreground space-y-1">
                  {accountType !== "max" && (message.cost_usd !== undefined || message.total_cost_usd !== undefined) && (
                    <div>Cost: ${((message.cost_usd || message.total_cost_usd)!).toFixed(4)} USD</div>
                  )}
                  {message.duration_ms !== undefined && (
                    <div>Duration: {formatDurationMs(message.duration_ms)}</div>
                  )}
                  {message.num_turns !== undefined && (
                    <div>Turns: {message.num_turns}</div>
                  )}
                  {message.usage && (
                    <div>
                      Total tokens: {message.usage.input_tokens + message.usage.output_tokens} 
                      ({message.usage.input_tokens} in, {message.usage.output_tokens} out)
                    </div>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
          <CardTimestamp receivedAt={message.receivedAt} message={message} />
        </Card>
      );
    }

    // Skip rendering if no meaningful content
    return null;
  } catch (error) {
    // If any error occurs during rendering, show a safe error message
    console.error("Error rendering stream message:", error, message);
    const errorStyle = accentStyleFor(renderConfig, "result.error");
    const errorSwatch = swatchFor(renderConfig, "result.error");
    return (
      <Card className={cn("border relative", className)} style={errorStyle}>
        <CardContent className="p-4 pb-9">
          <div className="flex items-start gap-3">
            <div
              className={iconWrapperClassName(renderConfig, "result.error")}
              style={iconWrapperStyle(renderConfig, errorSwatch, "result.error")}
            >
              <AlertCircle className={iconSizeClassName(renderConfig, "result.error")} />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium">Error rendering message</p>
              <p className="text-xs text-muted-foreground mt-1">
                {error instanceof Error ? error.message : 'Unknown error'}
              </p>
            </div>
          </div>
        </CardContent>
        <CardTimestamp receivedAt={message.receivedAt} message={message} />
      </Card>
    );
  }
};

export const StreamMessage = React.memo(StreamMessageComponent);
