import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Terminal,
  AlertCircle,
  CircleStop,
  Copy,
  Check,
  Download,
  RotateCcw,
} from "lucide-react";
import { detectSkillInjection } from "@/lib/skillDetection";
import { classifyStandaloneKind } from "@/lib/messageKind";
import { isBlockHiddenInCompact, isSystemContextText } from "@/lib/blockKind";
import { summarizeHiddenEvents } from "@/lib/hiddenEventsSummary";
import { HiddenBlocksExpander } from "@/components/HiddenBlocksExpander";
import { SubagentReturnedMarker } from "@/components/SubagentReturnedMarker";
import { isSubagentDispatch } from "@/lib/subagentDispatch";
import { extractResendPayload } from "@/lib/extractResendPayload";
import { formatDurationMs } from "@/lib/duration";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { accentStyleFor, swatchFor } from "@/lib/accentStyle";
import { headerLabelFor, iconNameFor } from "@/lib/kindPresentation";
import { contentClassNames, iconSizeClassName, iconWrapperClassName, iconWrapperStyle, typographyFontFamily } from "@/lib/typographyClasses";
import { IconRenderer } from "@/components/settings-panels/appearance/iconMap";
import { KindHeader } from "@/components/KindHeader";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getClaudeSyntaxTheme } from "@/lib/claudeSyntaxTheme";
import { buildMarkdownComponents } from "@/lib/markdownComponents";
import { useTheme } from "@/hooks";
import type { ClaudeStreamMessage, MessageContentBlock } from "@/types/claudeStream";
import {
  asToolInput,
  asToolInputOneOf,
  TOOLS_WITH_WIDGETS_LOWER,
  warnUnhandledKnownTool,
} from "@/lib/types/toolInput";
import { AnsweredAskUserQuestionCard } from "@/components/AnsweredAskUserQuestionCard";
import { CardActionBar, CardActionButton, CardActionDivider } from "@/components/CardActionBar";
import { fireAndLog } from "@/lib/fireAndLog";
import {
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

// Stable module-level reference: ReactMarkdown re-renders if `remarkPlugins`
// is a new array each call, which rebuilds nested Prism syntax-highlighted
// code blocks and kills active text selection in the inner card.
const REMARK_PLUGINS = [remarkGfm];

/** Extract all meaningful text from a message for copying.
 *  Assumes content is already an array — see lib/normalizeMessage for the
 *  ingress boundary that guarantees it. */
// Shared message-copy helper. Lives in `src/lib/messageCopy.ts` so the
// card action bar can use the same extraction logic; what's defined here
// used to walk only `content` (an array on assistant/user messages) and
// silently no-op'd on result cards, which is the bug that motivated the
// consolidation.

/** Image with a hover-reveal copy + download toolbar and click-to-zoom lightbox. */
const DownloadableImage: React.FC<{
  src: string;
  alt: string;
  mediaType?: string;
  className?: string;
}> = ({ src, alt, mediaType, className }) => {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

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

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      // Chromium's clipboard refuses most blob types other than PNG. Coerce
      // anything not already PNG via a canvas round-trip so paste-into-other-
      // apps actually works for JPEG/WebP/etc.
      let clipboardBlob = blob;
      if (blob.type !== 'image/png') {
        clipboardBlob = await encodeBlobAsPng(blob);
      }
      await navigator.clipboard.write([
        new ClipboardItem({ [clipboardBlob.type]: clipboardBlob }),
      ]);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1500);
    } catch (err) {
      console.error('Copy image to clipboard failed:', err);
    }
  };

  return (
    <>
      <div className="relative inline-block group/img">
        <img
          src={src}
          alt={alt}
          className={cn(className, 'cursor-zoom-in')}
          onClick={() => { setLightboxOpen(true); }}
        />
        <div
          className="absolute top-1 right-1 inline-flex items-center rounded-md border border-border bg-background/90 overflow-hidden opacity-0 group-hover/img:opacity-100 focus-within:opacity-100 transition-opacity z-10"
          role="toolbar"
          aria-label="Image actions"
        >
          <button
            onClick={handleCopy}
            className="inline-flex items-center justify-center h-6 w-6 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title={copied ? 'Copied!' : 'Copy image to clipboard'}
            aria-label="Copy image to clipboard"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <span className="h-4 w-px bg-border" aria-hidden />
          <button
            onClick={handleDownload}
            className="inline-flex items-center justify-center h-6 w-6 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title="Download image"
            aria-label="Download image"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] w-fit p-0 bg-transparent border-0 shadow-none">
          <DialogTitle className="sr-only">{alt || 'Image preview'}</DialogTitle>
          <img
            src={src}
            alt={alt}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-md"
          />
        </DialogContent>
      </Dialog>
    </>
  );
};

/** Re-encode any image blob as a PNG via an offscreen canvas. Used by the
 *  clipboard-copy path because Chromium only reliably accepts `image/png`
 *  in `ClipboardItem` — passing a JPEG blob silently no-ops in some
 *  versions. The round-trip discards EXIF and recompresses, which is fine
 *  for a "paste this into another app" scenario. */
async function encodeBlobAsPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((out) => {
        if (out) resolve(out);
        else reject(new Error('canvas.toBlob returned null'));
      }, 'image/png');
    });
  } finally {
    bitmap.close();
  }
}

/** Resend extra slot for the shared `CardActionBar` on user message cards. */
const ResendExtra: React.FC<{
  msg: unknown;
  onResend: (text: string, images?: string[]) => void;
}> = ({ msg, onResend }) => {
  const handleResend = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Use the shared extractor so we handle both shapes user messages arrive in:
    //   • live SDK stream  → content is an array of typed blocks
    //   • resumed/JSONL    → content is a raw string
    // The previous inline implementation only handled the array shape, which
    // made Resend a no-op on every resumed-session message (the empty text it
    // produced was filtered out downstream and the IPC frame went out empty).
    const { text, images } = extractResendPayload(msg);
    if (!text && !images) return;
    onResend(text, images);
  };
  return (
    <>
      <CardActionDivider />
      <CardActionButton onClick={handleResend} title="Resend message" ariaLabel="Resend message">
        <RotateCcw className="h-3.5 w-3.5" />
      </CardActionButton>
    </>
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
  if (showKind && message) {
    const t = message.type;
    // Only system / result variants carry a typed `subtype`; for everything
    // else the label is just the bare type name.
    const sub =
      'subtype' in message && typeof message.subtype === 'string'
        ? message.subtype
        : null;
    if (t) kindLabel = sub ? `${t} · ${sub}` : String(t);
  }

  const handleCopy = async () => {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(message, null, 2));
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 1200);
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
              onClick={fireAndLog('stream-message:click', handleCopy)}
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
  /** True when the timeline is in compact view mode. Drives per-block
   *  hiding for mixed-content messages — hidden blocks inside a visible
   *  parent get an inline `HiddenBlocksExpander`. Ignored when
   *  `inExpandedGroup` is true (opening the outer group is "show
   *  everything," so we don't double-collapse). */
  compact?: boolean;
  /** Called when the user clicks the resend button on a user message card. */
  onResend?: (text: string, images?: string[]) => void;
}

/**
 * Component to render a single Claude Code stream message
 */
const StreamMessageComponent: React.FC<StreamMessageProps> = ({ message, className, streamMessages, onLinkDetected, accountType, inExpandedGroup, compact, onResend }) => {
  // State to track tool results mapped by tool call ID
  const [toolResults, setToolResults] = useState<Map<string, MessageContentBlock>>(new Map());
  
  // Get current theme. Memoize the derived theme + components map so
  // ReactMarkdown sees stable prop references across renders — without
  // this, every render rebuilds the Prism-highlighted code DOM and the
  // browser drops any active text selection inside the inner code card.
  const { theme } = useTheme();
  const syntaxTheme = useMemo(() => getClaudeSyntaxTheme(theme), [theme]);
  const mdComponents = useMemo(() => buildMarkdownComponents(syntaxTheme), [syntaxTheme]);

  // Per-kind accent colors, live-reload from Appearance settings
  const { config: renderConfig } = useMessageRenderingConfig();
  
  // Extract all tool results from stream messages
  useEffect(() => {
    const results = new Map<string, MessageContentBlock>();

    // Iterate through all messages to find tool results
    streamMessages.forEach(msg => {
      if (msg.type === "user" && msg.message.content && Array.isArray(msg.message.content)) {
        (msg.message.content as MessageContentBlock[]).forEach((content) => {
          if (content.type === "tool_result" && content.tool_use_id) {
            results.set(content.tool_use_id, content);
          }
        });
      }
    });

    setToolResults(results);
  }, [streamMessages]);

  // Helper to get tool result for a specific tool call ID
  const getToolResult = (toolId: string | undefined): MessageContentBlock | null => {
    if (!toolId) return null;
    return toolResults.get(toolId) ?? null;
  };
  
  try {
    // Skip rendering for meta messages that don't have meaningful content.
    // Exempt skill-injection user messages — they arrive with isMeta:true from
    // JSONL (the live SDK variant uses isSynthetic instead) but carry the
    // SKILL.md body we want to render. Mirrors the same exemption in
    // src/lib/messageFilters.ts.
    if (
      message.isMeta &&
      message.type !== 'summary' &&
      !detectSkillInjection(message, streamMessages)
    ) {
      return null;
    }

    // Handle summary messages (synthesized for compaction summaries — they
    // carry { leafUuid, summary } and are the only variant with these fields).
    if (message.type === "summary" && message.leafUuid && message.summary) {
      return <SummaryWidget summary={message.summary} leafUuid={message.leafUuid} />;
    }

    // AskUserQuestion pair — elevate the answered card to a top-level
    // chat-feed message (no surrounding assistant bubble) and hide the
    // companion user message that carries just the tool_result. The kind
    // classifier in `messageKind.ts` only returns these for the clean
    // "single-block message" case; mixed assistant messages with text
    // or thinking alongside the tool_use fall through to the in-bubble
    // rendering below (renderToolWidget still has its own AskUserQuestion
    // branch for that path).
    {
      const upstandingKind = classifyStandaloneKind(message, streamMessages);
      if (upstandingKind === "tool.askUserQuestion.answered.result") {
        // The data is folded into the assistant-side answered card a few
        // rows up; rendering this user message as its own bubble would be
        // a redundant JSON-blob row.
        return null;
      }
      if (
        upstandingKind === "tool.askUserQuestion.answered"
        && message.type === "assistant"
        && message.message
        && Array.isArray(message.message.content)
      ) {
        const tu = message.message.content.find(
          (b): b is Extract<typeof b, { type: "tool_use" }> =>
            b?.type === "tool_use"
            && typeof (b as { name?: string }).name === "string"
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- name guaranteed string by typeof check on prior line.
            && (b as { name?: string }).name!.toLowerCase() === "askuserquestion",
        );
        if (tu) {
          // Look up the matching tool_result directly from `streamMessages`
          // rather than the `toolResults` state cache: the cache is
          // populated by a useEffect, so on the first render after the
          // result lands `getToolResult` would still return null and the
          // card would flash "(no answer recorded)" for one frame.
          // Classification already guarantees the result is in
          // streamMessages by the time we reach here.
          const tuId = (tu as { id?: string }).id;
          let resultContent: string | undefined;
          if (tuId) {
            outer: for (const m of streamMessages) {
              if (m.type !== "user") continue;
              const blocks = (m as { message?: { content?: unknown } }).message?.content;
              if (!Array.isArray(blocks)) continue;
              for (const b of blocks) {
                const block = b as { type?: string; tool_use_id?: string; content?: unknown };
                if (block?.type === "tool_result" && block.tool_use_id === tuId) {
                  resultContent =
                    typeof block.content === "string"
                      ? block.content
                      : block.content != null
                        ? JSON.stringify(block.content)
                        : undefined;
                  break outer;
                }
              }
            }
          }
          // Card wraps itself in MessageCard, so we return it directly.
          // `message` is passed through so MessageCard's footer can show
          // the receivedAt timestamp and the debug raw-JSON copy button
          // in the same shape every other first-order card uses.
          return (
            <AnsweredAskUserQuestionCard
              input={(tu as { input?: unknown }).input}
              resultContent={resultContent}
              message={message}
            />
          );
        }
      }
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

    // Fallback for any other system subtype (compact_boundary, future SDK
    // subtypes, etc.). Without this branch the message renders to null and
    // expanders summarized as "1 system event" reveal nothing when opened.
    // The 'init' subtype is handled above; the explicit `!== 'notification'`
    // guard keeps the dedicated notification renderer below reachable.
    if (message.type === "system" && message.subtype !== "notification") {
      const subtype = String(message.subtype);
      // System variants don't share a common text field; pick whichever
      // narrative-style field the specific subtype carries.
      const text =
        (message as { message?: unknown }).message
          ?? (message as { title?: unknown }).title
          ?? '';
      // The whole-message classifier maps every non-init/non-notification
      // system subtype to one of system.hook.started / system.hook.response /
      // system.userPromptSubmit / system.unknown. Use the resolved kind's
      // swatch for the left-rail color so Appearance customizations take
      // effect; default values match today's gray strip.
      const kindId = classifyStandaloneKind(message, streamMessages) ?? "system.unknown";
      const swatch = swatchFor(renderConfig, kindId);
      const borderStyle: React.CSSProperties = swatch ? { borderColor: swatch } : {};
      const textStyle: React.CSSProperties = swatch ? { color: swatch } : {};
      return (
        <div
          className={cn("flex items-start gap-2 text-xs font-mono py-1.5 px-3 border-l-2", !swatch && "border-muted-foreground/40 text-muted-foreground", className)}
          style={borderStyle}
        >
          <span className="opacity-70" style={textStyle}>system.{subtype}</span>
          {/* eslint-disable-next-line @typescript-eslint/no-base-to-string -- caller controls input; falls back to JSON.stringify upstream. */}
          {text && <span className="truncate" style={textStyle}>{String(text)}</span>}
        </div>
      );
    }

    // SDK notification — compact inline text styled like the "Pondering..."
    // activity indicator. Color-coded by notification_type:
    //   error → red     ✗
    //   warn  → yellow  ⚠
    //   stop  → red     ⏹ (user-initiated interrupt/cancel)
    //   info  → muted   💬
    if (message.type === "system" && message.subtype === "notification") {
      const notifType = message.notification_type ?? 'info';
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
            {message.title ? `${message.title}: ` : ''}
            {message.body ?? ''}
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
        const assistantText = (msg.content as MessageContentBlock[])
          .filter((c): c is import('@/types/claudeStream').MessageTextBlock => c.type === 'text')
          .map((c) => c.text)
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
              // `result` is only present on SDKResultSuccess; the error
              // variant carries `errors` instead and doesn't trigger this
              // de-dup path.
              if (
                next.type === 'result' &&
                next.subtype === 'success' &&
                next.result?.trim() === assistantText.trim()
              ) {
                suppressTextBlocks = true;
                break;
              }
            }
          }
          if (suppressTextBlocks) {
            const hasOtherContent = (msg.content as MessageContentBlock[]).some(
              (c) => c.type !== 'text',
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
          className={cn("border w-[95%] relative group/card", className)}
          style={assistantStyle}
        >
          <CardActionBar message={msg} />
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
              <div className="flex-1 space-y-2 min-w-0 overflow-x-auto">
                <KindHeader kindId="assistant.text" />
                {(() => {
                  const blocks: MessageContentBlock[] = Array.isArray(msg.content) ? (msg.content as MessageContentBlock[]) : [];
                  const renderBlock = (content: MessageContentBlock, idx: number) => {
                    // Text content - render as markdown
                    if (content.type === "text") {
                    if (suppressTextBlocks) return null;
                    // MessageTextBlock.text is typed string; the previous
                    // defensive `content.text?.text || JSON.stringify(...)`
                    // branch was unreachable per types. If a malformed
                    // payload sneaks in at runtime we'll see an exception
                    // here rather than silently stringifying the whole block.
                    const textContent = content.text;

                    renderedSomething = true;
                    return (
                      <div key={idx} className="prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={mdComponents}>
                          {textContent}
                        </ReactMarkdown>
                      </div>
                    );
                  }

                  // Thinking content - render with ThinkingWidget.
                  // Skip signature-only blocks (SDK returns { thinking: "", signature: "..." }
                  // when showThinkingSummaries is off — there's nothing to display).
                  if (content.type === "thinking") {
                    const thinkingText = content.thinking.trim();
                    if (!thinkingText) return null;
                    renderedSomething = true;
                    return (
                      <ThinkingWidget
                        key={idx}
                        thinking={content.thinking}
                        signature={content.signature}
                        defaultExpanded={inExpandedGroup}
                      />
                    );
                  }
                  
                  // Tool use - render custom widgets based on tool name.
                  // Tool inputs are narrowed from `unknown` to the SDK's
                  // per-tool input types via `asToolInput` (see
                  // src/lib/types/toolInput.ts). Tool names are PascalCase
                  // per SDK convention; the older `.toLowerCase()` defense
                  // was removed once the canonical wire shape was confirmed.
                  if (content.type === "tool_use") {
                    const toolName = content.name;
                    const rawInput: unknown = content.input;
                    const toolId = content.id;

                    // Get the tool result if available
                    const toolResult = getToolResult(toolId);

                    // Function to render the appropriate tool widget
                    const renderToolWidget = () => {
                      // AskUserQuestion is now always elevated to its own
                      // first-order card via the `tool.askUserQuestion.answered`
                      // standalone-kind branch above; rendering it again
                      // here (in-bubble for mixed-content assistant
                      // messages) would create card-in-card. Mixed-content
                      // cases — where the agent emits text or thinking
                      // alongside the AskUserQuestion tool_use in the same
                      // message — are rare and fall through to the generic
                      // tool_use display below. If they become a problem,
                      // the fix is to add a thin embedded variant on
                      // AnsweredAskUserQuestionCard, not to special-case
                      // this widget path again.

                      // Task / Agent tool — subagent dispatch. Both
                      // `isSubagentDispatch` and `asToolInputOneOf` are
                      // now case-sensitive against the SDK's PascalCase
                      // wire contract, so we pass `toolName` straight
                      // through without normalization.
                      const subagent = isSubagentDispatch(toolName)
                        ? asToolInputOneOf(toolName, ['Task', 'Agent'], rawInput)
                        : null;
                      if (subagent) {
                        renderedSomething = true;
                        return (
                          <TaskWidget
                            description={subagent.input.description}
                            prompt={subagent.input.prompt}
                            subagentType={subagent.input.subagent_type}
                            result={toolResult}
                          />
                        );
                      }

                      // Edit
                      const editInput = asToolInput(toolName, 'Edit', rawInput);
                      if (editInput?.file_path) {
                        renderedSomething = true;
                        return <EditWidget {...editInput} result={toolResult} />;
                      }

                      // MultiEdit
                      const multiEditInput = asToolInput(toolName, 'MultiEdit', rawInput);
                      if (multiEditInput?.file_path && multiEditInput.edits) {
                        renderedSomething = true;
                        return <MultiEditWidget {...multiEditInput} result={toolResult} />;
                      }

                      // MCP tools (anything starting with `mcp__`). The SDK
                      // models these as `McpInput` (open-shaped); we pass
                      // the raw input through to the generic MCP widget,
                      // which already treats it as a JSON blob to display.
                      if (toolName?.startsWith('mcp__')) {
                        renderedSomething = true;
                        return <MCPWidget toolName={toolName} input={rawInput as Record<string, unknown> | undefined} result={toolResult} />;
                      }

                      // TodoRead — input is empty by contract; widget reads
                      // todos from the tool result, not the input.
                      if (asToolInput(toolName, 'TodoRead', rawInput)) {
                        renderedSomething = true;
                        return <TodoReadWidget result={toolResult} />;
                      }

                      // LS
                      const lsInput = asToolInput(toolName, 'LS', rawInput);
                      if (lsInput?.path) {
                        renderedSomething = true;
                        return <LSWidget path={lsInput.path} result={toolResult} />;
                      }

                      // Read
                      const readInput = asToolInput(toolName, 'Read', rawInput);
                      if (readInput?.file_path) {
                        renderedSomething = true;
                        return <ReadWidget filePath={readInput.file_path} result={toolResult} />;
                      }

                      // Glob
                      const globInput = asToolInput(toolName, 'Glob', rawInput);
                      if (globInput?.pattern) {
                        renderedSomething = true;
                        return <GlobWidget pattern={globInput.pattern} result={toolResult} />;
                      }

                      // Bash
                      const bashInput = asToolInput(toolName, 'Bash', rawInput);
                      if (bashInput?.command) {
                        renderedSomething = true;
                        return <BashWidget command={bashInput.command} description={bashInput.description} result={toolResult} />;
                      }

                      // Write. Gate on `content !== undefined` not
                      // truthiness — empty content is a legitimate
                      // empty-file write (the SDK schema permits it
                      // and Claude Code emits it for `touch`-style
                      // operations). A truthiness check would silently
                      // drop empty-file writes through to the generic
                      // JSON display.
                      const writeInput = asToolInput(toolName, 'Write', rawInput);
                      if (writeInput?.file_path && writeInput.content !== undefined) {
                        renderedSomething = true;
                        return <WriteWidget filePath={writeInput.file_path} content={writeInput.content} result={toolResult} />;
                      }

                      // Grep. The `include` / `exclude` fields are carried
                      // by `GrepInputExtended` for back-compat with older
                      // session payloads; SDK's canonical fields are
                      // `glob` / `type` and live on `GrepInput` proper.
                      const grepInput = asToolInput(toolName, 'Grep', rawInput);
                      if (grepInput?.pattern) {
                        renderedSomething = true;
                        return <GrepWidget pattern={grepInput.pattern} include={grepInput.include} path={grepInput.path} exclude={grepInput.exclude} result={toolResult} />;
                      }

                      // WebSearch
                      const webSearchInput = asToolInput(toolName, 'WebSearch', rawInput);
                      if (webSearchInput?.query) {
                        renderedSomething = true;
                        return <WebSearchWidget query={webSearchInput.query} result={toolResult} />;
                      }

                      // WebFetch
                      const webFetchInput = asToolInput(toolName, 'WebFetch', rawInput);
                      if (webFetchInput?.url) {
                        renderedSomething = true;
                        return <WebFetchWidget url={webFetchInput.url} prompt={webFetchInput.prompt} result={toolResult} />;
                      }

                      // No branch matched. Dev-mode diagnostic: if the
                      // tool name was one we DO model in
                      // `KNOWN_TOOL_NAMES` (i.e. a widget should have
                      // matched), warn so the malformed-input case the
                      // SDK type adoption was meant to surface doesn't
                      // become a silent fall-through to JSON.
                      warnUnhandledKnownTool(toolName, rawInput);
                      return null;
                    };
                    
                    // Render the tool widget
                    const widget = renderToolWidget();
                    if (widget) {
                      renderedSomething = true;
                      return <React.Fragment key={idx}>{widget}</React.Fragment>;
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
                  };

                  const hidingActive = compact === true && inExpandedGroup !== true;
                  if (!hidingActive) {
                    return blocks.map((b, i) => renderBlock(b, i));
                  }

                  const out: React.ReactNode[] = [];
                  let pendingHidden: { block: MessageContentBlock; idx: number }[] = [];
                  const flush = () => {
                    if (pendingHidden.length === 0) return;
                    const items = pendingHidden;
                    pendingHidden = [];
                    // Synthetic message wrapper for summarizeHiddenEvents — the
                    // helper only reads `type` + `message.content`, so the
                    // partial shape is sufficient.
                    const syntheticMessage = {
                      type: 'assistant',
                      message: { content: items.map((i) => i.block) },
                    } as unknown as ClaudeStreamMessage;
                    const summary = summarizeHiddenEvents([syntheticMessage]);
                    out.push(
                      <HiddenBlocksExpander
                        key={`hb-${items[0].idx}`}
                        count={items.length}
                        summary={summary}
                      >
                        {items.map(({ block, idx }) => renderBlock(block, idx))}
                      </HiddenBlocksExpander>
                    );
                  };
                  for (let i = 0; i < blocks.length; i++) {
                    const b = blocks[i];
                    const hidden = isBlockHiddenInCompact(b, message, renderConfig);
                    if (hidden) {
                      pendingHidden.push({ block: b, idx: i });
                    } else {
                      flush();
                      out.push(renderBlock(b, i));
                    }
                  }
                  flush();
                  return out;
                })()}

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
      // Don't render meta messages — except skill-injected bodies, which
      // arrive with isMeta:true from JSONL but carry the SKILL.md content
      // we want to render. messageFilters has the same exemption upstream;
      // mirror it here so the renderer is correct on its own (defense-in-
      // depth in case filtering is bypassed).
      if (message.isMeta && !detectSkillInjection(message, streamMessages)) {
        return null;
      }

      // Handle different message structures
      const msg = message.message || message;

      // Check if this is a tool-result-only message first — must happen before
      // bracket-detection to avoid tool results with nested content arrays
      // being misidentified as SDK system messages (the array coerces to
      // "[object Object]" which starts/ends with brackets).
      const isToolResultOnly = Array.isArray(msg.content)
        && msg.content.length > 0
        && (msg.content as MessageContentBlock[]).every((c) => c.type === "tool_result");

      // Extract text content, handling nested content arrays from tool results.
      // Top-level content is always an array post boundary normalization
      // (lib/normalizeMessage); the tool_result block content (`c.content`)
      // can still legitimately be string OR array — tool-result block shape
      // isn't covered by the top-level normalization.
      const contentStr = Array.isArray(msg.content)
        ? (msg.content as MessageContentBlock[]).map((c) => {
            if (c.type === 'text') return c.text;
            if (c.type === 'tool_result') {
              if (typeof c.content === 'string') return c.content;
              if (Array.isArray(c.content)) {
                return c.content.map((inner) =>
                  typeof inner === 'string' ? inner : ('text' in inner && typeof inner.text === 'string' ? inner.text : '')
                ).join('');
              }
            }
            return '';
          }).join('')
        : '';

      // Detect system-injected context (skills, CLAUDE.md, system-reminders,
      // and hook feedback like "Stop hook feedback: ...") and render as a
      // collapsible System Context widget instead of a user-prompt card.
      // The helper centralizes the patterns shared with the block- and
      // whole-message-level classifiers in `blockKind.ts` / `messageKind.ts`.
      if (isSystemContextText(contentStr)) {
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

      // Pick card style from the configurable palette. Every variant now has
      // a dedicated kind id so Appearance customizations apply uniformly —
      // including the previously-hardcoded skill-injection / command /
      // command-output cases.
      const isCommand = !isToolResultOnly && !isSubagentPrompt && !skillInjection
        && contentStr.includes('<command-name>');
      const isCommandOutput = !isToolResultOnly && !isSubagentPrompt && !skillInjection
        && !isCommand
        && contentStr.includes('<local-command-stdout>');
      const userKindId = isToolResultOnly
        ? "tool.result.generic"
        : isSubagentPrompt
        ? "user.subagentPrompt"
        : skillInjection
        ? "user.skillInjection"
        : isCommand
        ? "user.command"
        : isCommandOutput
        ? "user.commandOutput"
        : "user.prompt";

      const userStyle: React.CSSProperties | undefined = accentStyleFor(renderConfig, userKindId);
      const userSwatch = swatchFor(renderConfig, userKindId);

      const cardStyle = {
        className: cn("border", className),
        style: userStyle,
      };

      const userIconName = userKindId ? iconNameFor(renderConfig, userKindId) : null;
      // Show the configured kind header on every user-side card, including
      // tool_result-only ones. Previously this excluded isToolResultOnly,
      // which silently swallowed the user's customized "Tool Result" label
      // for subagent return markers and other tool result cards.
      const showUserHeader = !!userKindId;

      const userKindIdForIcon = userKindId ?? undefined;
      const iconSize = iconSizeClassName(renderConfig, userKindIdForIcon);
      const fallbackIconName = isToolResultOnly
        ? "Terminal"
        : skillInjection
        ? "Sparkles"
        : isSubagentPrompt
        ? "Bot"
        : "User";
      const cardIcon = (
        <div
          className={iconWrapperClassName(renderConfig, userKindIdForIcon)}
          style={iconWrapperStyle(renderConfig, userSwatch, userKindIdForIcon)}
        >
          <IconRenderer name={userIconName ?? fallbackIconName} className={iconSize} />
        </div>
      );

      const showResend = !!onResend && !isToolResultOnly && !isSubagentPrompt && !skillInjection;

      const renderedCard = (
        <div className={isToolResultOnly ? "" : "flex justify-end"}>
        <Card className={cn(cardStyle.className, !isToolResultOnly && "w-[95%]", "group/card relative")} style={cardStyle.style}>
          {!isToolResultOnly ? (
            <CardActionBar
              message={msg}
              ariaLabel="User message actions"
              extras={showResend && onResend ? <ResendExtra msg={msg} onResend={onResend} /> : undefined}
            />
          ) : (
            <CardActionBar message={msg} />
          )}
          <CardContent className="p-4 pb-9">
            <div className="flex items-start gap-3">
              {cardIcon}
              <div className="flex-1 space-y-2 min-w-0 overflow-x-auto">
                {/* Configured KindHeader for the card. Renders once at the top
                    of the body so per-block branches (string, image, tool_result)
                    no longer have to repeat the header inline — and tool_result-
                    only cards (subagent returns, etc.) don't lose the header. */}
                {showUserHeader && userKindId && <KindHeader kindId={userKindId} />}
                {skillInjection && (
                  <div
                    className="text-xs font-medium font-mono"
                    style={userSwatch ? { color: userSwatch } : undefined}
                  >
                    Skill: {skillInjection.skillName}
                  </div>
                )}
                {/* Render every block of the user message's content array.
                    Boundary normalization (lib/normalizeMessage) guarantees
                    `msg.content` is always an array here — JSONL strings get
                    wrapped into a single text block at ingress. */}
                {(msg.content as MessageContentBlock[]).map((content, idx) => {
                  // Text block.
                  //
                  // Plain `/clear`-style slash invocations and their local
                  // stdout responses arrive as text whose body is a
                  // pseudo-XML envelope. Render those through the dedicated
                  // widgets so the card looks the same as it did before
                  // boundary normalization; also extract inline
                  // `@/path/to/image.png` references as DownloadableImages.
                  if (content.type === "text") {
                    const text = content.text;
                    renderedSomething = true;

                    const slashMatch = /<command-name>(.+?)<\/command-name>[\s\S]*?<command-message>(.+?)<\/command-message>[\s\S]*?<command-args>(.*?)<\/command-args>/.exec(text);
                    if (slashMatch) {
                      const [, slashName, slashMessage, slashArgs] = slashMatch;
                      return (
                        <CommandWidget
                          key={idx}
                          commandName={slashName.trim()}
                          commandMessage={slashMessage.trim()}
                          commandArgs={slashArgs?.trim()}
                        />
                      );
                    }

                    const stdoutMatch = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
                    if (stdoutMatch) {
                      const [, output] = stdoutMatch;
                      return <CommandOutputWidget key={idx} output={output} onLinkDetected={onLinkDetected} />;
                    }

                    const imagePathRegex = /@(\/[^\s@]+\.(?:png|jpe?g|gif|webp|svg))/gi;
                    const imagePaths: string[] = [];
                    let match;
                    while ((match = imagePathRegex.exec(text)) !== null) {
                      imagePaths.push(match[1]);
                    }
                    const textWithoutImages = imagePaths.length > 0
                      ? text.replace(imagePathRegex, '').trim()
                      : text;

                    return (
                      <div key={idx}>
                        {textWithoutImages && (
                          <div
                            className={cn(contentClassNames(renderConfig), "whitespace-pre-wrap")}
                            style={{ fontFamily: typographyFontFamily(renderConfig.typography.content) }}
                          >
                            {textWithoutImages}
                          </div>
                        )}
                        {imagePaths.length > 0 && (
                          <div className="flex flex-wrap gap-2 mt-2">
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
                    // Skip duplicate tool_result if a dedicated widget is present.
                    // Task is special-cased: TaskWidget renders the dispatch
                    // ("Subagent spawned"), but the return value still needs a
                    // chronological marker — render SubagentReturnedMarker here
                    // instead of suppressing entirely.
                    let hasCorrespondingWidget = false;
                    let isTaskReturn = false;
                    let taskDescription: string | undefined;
                    if (content.tool_use_id && streamMessages) {
                      for (let i = streamMessages.length - 1; i >= 0; i--) {
                        const prevMsg = streamMessages[i];
                        if (prevMsg.type === 'assistant' && prevMsg.message?.content && Array.isArray(prevMsg.message.content)) {
                          // Narrow each block via shape so BetaToolUseBlock's
                          // `name` / `input` are reachable without `as any`.
                          const toolUse = prevMsg.message.content.find(
                            (c): c is Extract<typeof c, { type: 'tool_use' }> =>
                              c?.type === 'tool_use' && (c as { id?: string }).id === content.tool_use_id,
                          );
                          if (toolUse) {
                            const toolNameLower = toolUse.name?.toLowerCase() ?? '';
                            if (isSubagentDispatch(toolUse.name)) {
                              isTaskReturn = true;
                              taskDescription = (toolUse.input as { description?: string } | undefined)?.description;
                            } else if (TOOLS_WITH_WIDGETS_LOWER.has(toolNameLower) || toolUse.name?.startsWith('mcp__')) {
                              hasCorrespondingWidget = true;
                            }
                            break;
                          }
                        }
                      }
                    }

                    if (isTaskReturn) {
                      const text = typeof content.content === 'string'
                        ? content.content
                        : Array.isArray(content.content)
                          ? content.content.map((c) => (typeof c === 'string' ? c : ('text' in c && typeof c.text === 'string' ? c.text : ''))).join('\n')
                          : '';
                      renderedSomething = true;
                      return (
                        <SubagentReturnedMarker
                          key={idx}
                          description={taskDescription}
                          resultText={text}
                          defaultExpanded={inExpandedGroup}
                        />
                      );
                    }

                    if (hasCorrespondingWidget) {
                      return null;
                    }
                    // Extract the actual content string
                    let contentText = '';
                    if (typeof content.content === 'string') {
                      contentText = content.content;
                    } else if (Array.isArray(content.content)) {
                      // Handle array of content blocks
                      contentText = content.content
                        .map((c) => (typeof c === 'string' ? c : ('text' in c && typeof c.text === 'string' ? c.text : JSON.stringify(c))))
                        .join('\n');
                    } else if (content.content && typeof content.content === 'object') {
                      // Fallback to JSON stringify
                      contentText = JSON.stringify(content.content, null, 2);
                    }


                    // Always show system reminders regardless of widget status
                    const reminderMatch = /<system-reminder>(.*?)<\/system-reminder>/s.exec(contentText);
                    if (reminderMatch) {
                      const reminderMessage = reminderMatch[1].trim();
                      const beforeReminder = contentText.substring(0, reminderMatch.index || 0).trim();
                      const afterReminder = contentText.substring((reminderMatch.index || 0) + reminderMatch[0].length).trim();

                      renderedSomething = true;
                      return (
                        <div key={idx} className="space-y-2">
                          <KindHeader kindId="tool.result.generic" fallbackLabel="Tool Result" />

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
                          <KindHeader kindId="tool.result.generic" fallbackLabel="Edit Result" />
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
                          <KindHeader kindId="tool.result.generic" fallbackLabel="MultiEdit Result" />
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
                          if (prevMsg.type === 'assistant' && prevMsg.message.content && Array.isArray(prevMsg.message.content)) {
                            const toolUse = (prevMsg.message.content as MessageContentBlock[]).find((c) =>
                              c.type === 'tool_use' &&
                              c.id === content.tool_use_id &&
                              c.name.toLowerCase() === 'ls'
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
                          <KindHeader kindId="tool.result.generic" fallbackLabel="Directory Contents" />
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
                            const toolUse = prevMsg.message.content.find(
                              (c): c is Extract<typeof c, { type: 'tool_use' }> =>
                                c?.type === 'tool_use' &&
                                (c as { id?: string }).id === content.tool_use_id &&
                                (c as { name?: string }).name?.toLowerCase() === 'read',
                            );
                            const fp = (toolUse?.input as { file_path?: string } | undefined)?.file_path;
                            if (fp) {
                              filePath = fp;
                              break;
                            }
                          }
                        }
                      }
                      
                      renderedSomething = true;
                      return (
                        <div key={idx} className="space-y-2">
                          <KindHeader kindId="tool.result.generic" fallbackLabel="Read Result" />
                          <ReadResultWidget content={contentText} filePath={filePath} />
                        </div>
                      );
                    }

                    // Handle empty tool results
                    if (!contentText || contentText.trim() === '') {
                      renderedSomething = true;
                      return (
                        <div key={idx} className="space-y-2">
                          <KindHeader kindId="tool.result.generic" fallbackLabel="Tool Result" />
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
                          ? <KindHeader kindId="result.error" fallbackLabel="Tool Error" fallbackIcon="AlertCircle" showIcon />
                          : <KindHeader kindId="tool.result.generic" fallbackLabel="Tool Result" />}
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
        <Card className={cn("border relative group/card", className)} style={resultStyle}>
          <CardActionBar message={message} />
          <CardContent className="p-4 pb-9">
            <div className="flex items-start gap-3">
              <div
                className={iconWrapperClassName(renderConfig, resultKindId)}
                style={iconWrapperStyle(renderConfig, resultSwatch, resultKindId)}
              >
                <IconRenderer name={resultIconName} className={iconSizeClassName(renderConfig, resultKindId)} />
              </div>
              <div className="flex-1 space-y-2 min-w-0 overflow-x-auto">
                <KindHeader kindId={resultKindId} fallbackLabel={resultFallbackLabel} />

                {message.subtype === 'success' && message.result && (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={mdComponents}>
                      {message.result}
                    </ReactMarkdown>
                  </div>
                )}

                {/* SDKResultError carries `errors: string[]` (plural). The
                    pre-SDK-anchored shape exposed a legacy `error` field that
                    never matched the SDK wire — drop the lookup and join the
                    typed array instead. */}
                {message.subtype !== 'success' && message.errors?.length ? (
                  <div className="text-sm text-destructive">{message.errors.join('\n')}</div>
                ) : null}

                <hr className="border-t border-border/50 my-2" />
                <div className="text-xs text-muted-foreground space-y-1">
                  {accountType !== "max" && message.total_cost_usd !== undefined && (
                    <div>Cost: ${message.total_cost_usd.toFixed(4)} USD</div>
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
