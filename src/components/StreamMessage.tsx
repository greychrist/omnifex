import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Terminal,
  Copy,
  Check,
  Download,
  RotateCcw,
} from "lucide-react";
import { detectSkillInjection } from "@/lib/skillDetection";
import { classifyStandaloneKind } from "@/lib/messageKind";
import { classifyBlockKind, isBlockHiddenInCompact, isSystemContextText, deriveSystemContextLabel } from "@/lib/blockKind";
import { resolveKind } from "@/lib/messageRenderingConfig";
import { summarizeHiddenEvents } from "@/lib/hiddenEventsSummary";
import { HiddenBlocksExpander } from "@/components/HiddenBlocksExpander";
import { SubagentReturnedMarker } from "@/components/SubagentReturnedMarker";
import { isSubagentDispatch } from "@/lib/subagentDispatch";
import { extractResendPayload } from "@/lib/extractResendPayload";
import { formatDurationMs } from "@/lib/duration";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { swatchFor } from "@/lib/accentStyle";
import { KindHeader } from "@/components/KindHeader";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getClaudeSyntaxTheme } from "@/lib/claudeSyntaxTheme";
import { buildMarkdownComponents } from "@/lib/markdownComponents";
import { useTheme } from "@/hooks";
import type { JsonlNode } from "@/types/jsonl";
import type { MessageContentBlock } from "@/types/claudeStream";
import {
  asToolInput,
  asToolInputOneOf,
  TOOLS_WITH_WIDGETS_LOWER,
  warnUnhandledKnownTool,
} from "@/lib/types/toolInput";
import { AnsweredAskUserQuestionCard } from "@/components/AnsweredAskUserQuestionCard";
import { CardActionBar, CardActionButton, CardActionDivider } from "@/components/CardActionBar";
import { MessageFrame } from "@/components/StreamMessage/MessageFrame";
import { CliInitBadge } from "@/components/StreamMessage/CliInitBadge";
import { CliResultBadge } from "@/components/StreamMessage/CliResultBadge";
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
  WebFetchWidget
} from "./ToolWidgets";
import { turnDuration } from "@/lib/sessionDerivedState";

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
    //   • live CLI stream  → content is an array of typed blocks
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


// ─── Completion band ────────────────────────────────────────────────────────

const TERMINAL_STOP_REASONS = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'refusal',
  'model_context_window_exceeded',
]);

const INPUT_RATE = 0.000003;
const OUTPUT_RATE = 0.000015;

function AssistantCompletionBand({
  node,
  allMessages,
  index,
  accountType,
}: {
  node: Extract<JsonlNode, { kind: 'assistant' }>;
  allMessages: JsonlNode[];
  index: number;
  accountType?: string;
}) {
  const stopReason = (node.raw as { message?: { stop_reason?: string | null } }).message?.stop_reason;
  if (!stopReason || !TERMINAL_STOP_REASONS.has(stopReason)) return null;

  const duration = turnDuration(allMessages, index);
  const usage = (node.raw as { message?: { usage?: Record<string, unknown> } }).message?.usage ?? {};
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
  const cost = inputTokens * INPUT_RATE + outputTokens * OUTPUT_RATE;

  const parts: string[] = [];
  if (duration !== null) parts.push(formatDurationMs(duration));
  parts.push(`${inputTokens} in / ${outputTokens} out`);
  if (cacheRead > 0) parts.push(`${cacheRead} cached`);
  if (accountType !== 'max') parts.push(`$${cost.toFixed(4)}`);

  return (
    <div className="text-xs text-muted-foreground/70 mt-1 px-1 flex items-center gap-2">
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span aria-hidden="true">·</span>}
          <span>{p}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface StreamMessageProps {
  message: JsonlNode;
  streamMessages: JsonlNode[];
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
const StreamMessageComponent: React.FC<StreamMessageProps> = ({ message, streamMessages, onLinkDetected, accountType, inExpandedGroup, compact, onResend }) => {
  // Get current theme. Memoize the derived theme + components map so
  // ReactMarkdown sees stable prop references across renders — without
  // this, every render rebuilds the Prism-highlighted code DOM and the
  // browser drops any active text selection inside the inner code card.
  const { theme } = useTheme();
  const syntaxTheme = useMemo(() => getClaudeSyntaxTheme(theme), [theme]);
  const mdComponents = useMemo(() => buildMarkdownComponents(syntaxTheme), [syntaxTheme]);

  // Per-kind accent colors, live-reload from Appearance settings
  const { config: renderConfig } = useMessageRenderingConfig();

  // Extract all tool results from stream messages, keyed by tool_use_id.
  // Computed during render (useMemo) rather than in an effect+setState: the
  // old effect forced a second render of every mounted message on every stream
  // tick, and left a one-frame window where results were missing on first
  // paint. useMemo recomputes only when the streamMessages identity changes —
  // same trigger, half the renders, no flash.
  const toolResults = useMemo(() => {
    const results = new Map<string, MessageContentBlock>();
    streamMessages.forEach(node => {
      if (node.kind !== 'user') return;
      const w = node.raw;
      if (w.message && w.message.content && Array.isArray(w.message.content)) {
        (w.message.content as MessageContentBlock[]).forEach((content) => {
          if (content.type === "tool_result" && content.tool_use_id) {
            results.set(content.tool_use_id, content);
          }
        });
      }
    });
    return results;
  }, [streamMessages]);

  // Helper to get tool result for a specific tool call ID
  const getToolResult = (toolId: string | undefined): MessageContentBlock | null => {
    if (!toolId) return null;
    return toolResults.get(toolId) ?? null;
  };
  
  try {
    // ── Top-level dispatch on message.kind ──────────────────────────────────
    // Inner field access may still read `wire` (= message.raw as ClaudeStreamMessage)
    // for convenience, but every routing decision is on message.kind.

    // Live-overlay transport / non-transcript artifacts: never render in the
    // message feed (these aren't JSONL transcript lines).
    if (
      message.kind === 'stream-event' ||
      message.kind === 'rate-limit' ||
      message.kind === 'lifecycle'
    ) {
      return null;
    }

    // Bookkeeping JSONL kinds — previously dropped, now rendered as a one-line
    // side-line marker so every JSONL line has a reference in the feed. Each is
    // a registry kind (see KIND_REGISTRY), so its chrome/visibility is fully
    // controllable in Settings → Chats. Routed through MessageFrame with the
    // kind id as streamKind.
    if (
      message.kind === 'permission-mode' ||
      message.kind === 'last-prompt' ||
      message.kind === 'ai-title' ||
      message.kind === 'queue-operation' ||
      message.kind === 'file-history-snapshot'
    ) {
      const body = (() => {
        switch (message.kind) {
          case 'permission-mode':
            return `Permission → ${message.raw.permissionMode}`;
          case 'last-prompt':
            return 'Bookmarked prompt';
          case 'ai-title':
            return `Session titled "${message.raw.aiTitle}"`;
          case 'queue-operation':
            return `Background: ${message.raw.operation}`;
          case 'file-history-snapshot':
            return message.raw.messageId
              ? `File snapshot (${message.raw.messageId})`
              : 'File snapshot';
        }
      })();
      return (
        <MessageFrame streamKind={message.kind} message={message}>
          <span className="text-xs font-mono">{body}</span>
        </MessageFrame>
      );
    }

    // Synthetic control-change markers (effort/model/permission). One render
    // branch for the whole family; the row text is the only difference.
    if (message.kind === 'control-change') {
      const labels: Record<'effort' | 'model' | 'permission', string> = {
        effort: 'Effort',
        model: 'Model',
        permission: 'Permission',
      };
      return (
        <MessageFrame streamKind={`control.${message.control}`} message={message}>
          <span className="text-xs font-mono">{labels[message.control]} → {message.value}</span>
        </MessageFrame>
      );
    }

    if (message.kind === 'system') {
      const sysRaw = message.raw;

      // CLI notification — route through MessageFrame.
      if (message.subtype === "notification") {
        const streamKind = classifyStandaloneKind(message, streamMessages) ?? "system.notification";
        return (
          <MessageFrame streamKind={streamKind} message={message}>
            <span className="text-xs font-mono">
              {sysRaw.title ? `${sysRaw.title}: ` : ''}
              {(sysRaw as unknown as { body?: string }).body ?? ''}
            </span>
          </MessageFrame>
        );
      }

      // Fallback for any other system subtype (compact_boundary, future CLI
      // subtypes, etc.). Route through MessageFrame so Appearance config takes
      // effect.
      const subtype = String(message.subtype);
      // System variants don't share a common text field; pick whichever
      // narrative-style field the specific subtype carries. `content` holds the
      // recap body for summary subtypes like away_summary / stop_hook_summary.
      const text =
        (sysRaw as unknown as { message?: unknown }).message
          ?? (sysRaw as unknown as { content?: unknown }).content
          ?? sysRaw.title
          ?? '';
      const streamKind = classifyStandaloneKind(message, streamMessages) ?? "system.informational";
      // away_summary is a user-facing recap, not diagnostics: prose body
      // (regular font, italic) with no inline subtype label — the card's
      // configured header + footer chip already identify the kind.
      const isAwaySummary = subtype === 'away_summary';
      return (
        <MessageFrame streamKind={streamKind} message={message}>
          {!isAwaySummary && (
            <span className="text-xs font-mono opacity-70">system.{subtype}</span>
          )}
          {/* eslint-disable-next-line @typescript-eslint/no-base-to-string -- caller controls input; falls back to JSON.stringify upstream. */}
          {text && (
            <span
              className={cn(
                "block whitespace-pre-wrap break-words",
                isAwaySummary ? "text-sm italic" : "text-xs font-mono",
              )}
            >
              {String(text)}
            </span>
          )}
        </MessageFrame>
      );
    }

    if (message.kind === 'cli-stream-init') {
      return <CliInitBadge node={message} />;
    }

    if (message.kind === 'cli-stream-result') {
      return <CliResultBadge node={message} />;
    }

    if (message.kind === 'unknown') {
      // unknown nodes carry an untyped raw bag — use explicit type assertions below.
      const unknownRaw = message.raw;

      // Skip rendering for meta messages that don't have meaningful content.
      if (
        unknownRaw.isMeta &&
        unknownRaw.type !== 'summary' &&
        !detectSkillInjection(message, streamMessages)
      ) {
        return null;
      }

      // Handle summary messages (synthesized for compaction summaries — they
      // carry { leafUuid, summary } and are the only variant with these fields).
      if (unknownRaw.type === "summary" && unknownRaw.leafUuid && unknownRaw.summary) {
        return <SummaryWidget summary={unknownRaw.summary as string} leafUuid={unknownRaw.leafUuid as string} />;
      }

      // All other unknown kinds — nothing to render.
      return null;
    }

    // AskUserQuestion pair — elevate the answered card to a top-level
    // chat-feed message (no surrounding assistant bubble) and hide the
    // companion user message that carries just the tool_result. The kind
    // classifier in `messageKind.ts` only returns these for the clean
    // "single-block message" case; mixed assistant messages with text
    // or thinking alongside the tool_use fall through to the in-bubble
    // rendering below (renderToolWidget still has its own AskUserQuestion
    // branch for that path).
    if (message.kind === 'assistant' || message.kind === 'user') {
      const upstandingKind = classifyStandaloneKind(message, streamMessages);
      if (upstandingKind === "tool.askUserQuestion.answered.result") {
        // The data is folded into the assistant-side answered card a few
        // rows up; rendering this user message as its own bubble would be
        // a redundant JSON-blob row.
        return null;
      }
      if (
        upstandingKind === "tool.askUserQuestion.answered"
        && message.kind === "assistant"
        && message.raw.message
        && Array.isArray(message.raw.message.content)
      ) {
        const tu = (message.raw.message.content as unknown[]).find(
          (b): b is { type: "tool_use"; name: string; id?: string; input?: unknown } =>
            (b as { type?: string }).type === "tool_use"
            && typeof (b as { name?: string }).name === "string"
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- name guaranteed string by typeof check on prior line.
            && (b as { name?: string }).name!.toLowerCase() === "askuserquestion",
        );
        if (tu) {
          // Look up the matching tool_result directly from `streamMessages`.
          // (`toolResults` is now a synchronous useMemo so a cache lookup would
          // also work; this direct scan is kept as the explicit, self-contained
          // path for this branch.) Classification already guarantees the result
          // is in streamMessages by the time we reach here.
          const tuId = tu.id;
          let resultContent: string | undefined;
          if (tuId) {
            outer: for (const node of streamMessages) {
              if (node.kind !== 'user') continue;
              const blocks = node.raw.message?.content;
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
              input={tu.input}
              resultContent={resultContent}
              message={message}
            />
          );
        }
      }
    }

    // Assistant message — no outer wrapper. Each content block gets its own
    // MessageFrame so the block's kind controls its own chrome.
    if (message.kind === "assistant" && message.raw.message) {
      // Find our index in streamMessages for the completion band.
      const assistantIndex = (() => {
        const idx = streamMessages.indexOf(message);
        if (idx !== -1) return idx;
        return streamMessages.findIndex((m) => m === message);
      })();
      const msg = message.raw.message;

      // NOTE: the assistant's text is rendered as-is. We do NOT suppress it
      // when it matches the following CLI `result` row — that row renders
      // nothing (the `unknown` branch returns null), so suppressing here
      // erased the final message outright. Under --include-partial-messages
      // the committed assistant carries stop_reason: null, so it isn't even
      // the green "execution complete" card; it's just the normal reply, and
      // it must always show.

      const blocks: MessageContentBlock[] = Array.isArray(msg.content) ? (msg.content as MessageContentBlock[]) : [];

      // Render the body of a single content block (no frame wrapper — the
      // frame is added outside this function by the caller).
      const renderBlockBody = (content: MessageContentBlock, idx: number): React.ReactNode => {
        // Text content - render as markdown
        if (content.type === "text") {
          const textContent = content.text;
          return (
            <div key={idx} className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={mdComponents}>
                {textContent}
              </ReactMarkdown>
            </div>
          );
        }

        // Thinking content - render with ThinkingWidget.
        // Skip signature-only blocks (CLI returns { thinking: "", signature: "..." }
        // when showThinkingSummaries is off — there's nothing to display).
        if (content.type === "thinking") {
          const thinkingText = content.thinking.trim();
          if (!thinkingText) return null;
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
        if (content.type === "tool_use") {
          const toolName = content.name;
          const rawInput: unknown = content.input;
          const toolId = content.id;

          // Get the tool result if available
          const toolResult = getToolResult(toolId);

          // Function to render the appropriate tool widget
          const renderToolWidget = () => {
            // Task / Agent tool — subagent dispatch.
            const subagent = isSubagentDispatch(toolName)
              ? asToolInputOneOf(toolName, ['Task', 'Agent'], rawInput)
              : null;
            if (subagent) {
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
              return <EditWidget {...editInput} result={toolResult} />;
            }

            // MultiEdit
            const multiEditInput = asToolInput(toolName, 'MultiEdit', rawInput);
            if (multiEditInput?.file_path && multiEditInput.edits) {
              return <MultiEditWidget {...multiEditInput} result={toolResult} />;
            }

            // MCP tools (anything starting with `mcp__`).
            if (toolName?.startsWith('mcp__')) {
              return <MCPWidget toolName={toolName} input={rawInput as Record<string, unknown> | undefined} result={toolResult} />;
            }

            // TodoRead
            if (asToolInput(toolName, 'TodoRead', rawInput)) {
              return <TodoReadWidget result={toolResult} />;
            }

            // LS
            const lsInput = asToolInput(toolName, 'LS', rawInput);
            if (lsInput?.path) {
              return <LSWidget path={lsInput.path} result={toolResult} />;
            }

            // Read
            const readInput = asToolInput(toolName, 'Read', rawInput);
            if (readInput?.file_path) {
              return <ReadWidget filePath={readInput.file_path} result={toolResult} />;
            }

            // Glob
            const globInput = asToolInput(toolName, 'Glob', rawInput);
            if (globInput?.pattern) {
              return <GlobWidget pattern={globInput.pattern} result={toolResult} />;
            }

            // Bash
            const bashInput = asToolInput(toolName, 'Bash', rawInput);
            if (bashInput?.command) {
              return <BashWidget command={bashInput.command} description={bashInput.description} result={toolResult} />;
            }

            // Write
            const writeInput = asToolInput(toolName, 'Write', rawInput);
            if (writeInput?.file_path && writeInput.content !== undefined) {
              return <WriteWidget filePath={writeInput.file_path} content={writeInput.content} result={toolResult} />;
            }

            // Grep
            const grepInput = asToolInput(toolName, 'Grep', rawInput);
            if (grepInput?.pattern) {
              return <GrepWidget pattern={grepInput.pattern} include={grepInput.include} path={grepInput.path} exclude={grepInput.exclude} result={toolResult} />;
            }

            // WebSearch
            const webSearchInput = asToolInput(toolName, 'WebSearch', rawInput);
            if (webSearchInput?.query) {
              return <WebSearchWidget query={webSearchInput.query} result={toolResult} />;
            }

            // WebFetch
            const webFetchInput = asToolInput(toolName, 'WebFetch', rawInput);
            if (webFetchInput?.url) {
              return <WebFetchWidget url={webFetchInput.url} prompt={webFetchInput.prompt} result={toolResult} />;
            }

            warnUnhandledKnownTool(toolName, rawInput);
            return null;
          };

          const widget = renderToolWidget();
          if (widget) {
            return <React.Fragment key={idx}>{widget}</React.Fragment>;
          }

          // Fallback to basic tool display
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

      // Determine which blocks are visible. A block is "visible" if
      // renderBlockBody would return non-null. We need to know which blocks
      // produce output so we can find the last card-presentation block for
      // toolbar attachment.
      const visibleBlocks = blocks.filter((b) => {
        if (b.type === 'thinking' && !b.thinking.trim()) return false;
        return true;
      });

      if (visibleBlocks.length === 0) return null;

      // Hoist hidingActive here so lastCardIdx can consult it.
      const hidingActive = compact === true && inExpandedGroup !== true;

      // Find the index (in visibleBlocks) of the last block whose kind has
      // presentation:'card' AND (in compact mode) will actually be visible —
      // not tucked inside HiddenBlocksExpander. Attaching the toolbar to a
      // collapsed block makes it invisible to the user.
      // Falls back to "last block of any kind" only when no card+visible block
      // exists.
      const lastCardIdx = (() => {
        let last = visibleBlocks.length - 1; // fallback: last block
        for (let i = visibleBlocks.length - 1; i >= 0; i--) {
          const blockKind = classifyBlockKind(visibleBlocks[i], message);
          const presentation = blockKind ? resolveKind(renderConfig, blockKind).presentation : 'card';
          if (presentation !== 'card') continue;
          // In compact mode, prefer a block that will actually be visible —
          // otherwise the toolbar would end up inside HiddenBlocksExpander
          // (collapsed by default).
          if (hidingActive) {
            const willBeHidden = isBlockHiddenInCompact(visibleBlocks[i], message, renderConfig);
            if (willBeHidden) continue;
          }
          last = i;
          break;
        }
        return last;
      })();

      // Wrap each visible block in its own MessageFrame. The toolbar is
      // attached to the frame at `lastCardIdx`.
      const renderWrappedBlock = (block: MessageContentBlock, visibleIdx: number, originalIdx: number): React.ReactNode => {
        const blockKind = classifyBlockKind(block, message) ?? 'unknown';
        const isToolbarBlock = visibleIdx === lastCardIdx;
        const toolbar = isToolbarBlock
          ? <CardActionBar message={msg} />
          : undefined;
        const body = renderBlockBody(block, originalIdx);
        if (body === null) return null;
        return (
          <MessageFrame
            key={originalIdx}
            streamKind={blockKind}
            message={message}
            actionBar={toolbar}
          >
            {body}
          </MessageFrame>
        );
      };

      let renderedSomething = false;
      let output: React.ReactNode[];

      if (!hidingActive) {
        // Map blocks back through original index for stable keys
        let vIdx = 0;
        output = blocks.map((b, origIdx) => {
          if (b.type === 'thinking' && !b.thinking.trim()) return null;
          const node = renderWrappedBlock(b, vIdx, origIdx);
          if (node !== null) { renderedSomething = true; vIdx++; }
          return node;
        });
      } else {
        // Compact mode: group hidden blocks into HiddenBlocksExpander.
        // We need to map over all original blocks but track visible index
        // separately.
        const out: React.ReactNode[] = [];
        let pendingHidden: { block: MessageContentBlock; origIdx: number; vIdx: number }[] = [];
        let vIdx = 0;

        const flush = () => {
          if (pendingHidden.length === 0) return;
          const items = pendingHidden;
          pendingHidden = [];
          // Build a synthetic JsonlNode wrapping just the hidden blocks
          // so summarizeHiddenEvents (which now accepts JsonlNode[]) can tally them.
          const syntheticNode: JsonlNode = {
            kind: 'assistant',
            sessionId: '',
            receivedAt: '',
            raw: {
              type: 'assistant',
              message: { role: 'assistant', content: items.map((i) => i.block) },
            },
          };
          const summary = summarizeHiddenEvents([syntheticNode]);
          out.push(
            <HiddenBlocksExpander
              key={`hb-${items[0].origIdx}`}
              count={items.length}
              summary={summary}
            >
              {items.map(({ block, origIdx, vIdx: vi }) => renderWrappedBlock(block, vi, origIdx))}
            </HiddenBlocksExpander>
          );
        };

        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          // Skip empty blocks (they don't count as visible)
          if (b.type === 'thinking' && !b.thinking.trim()) continue;

          const hidden = isBlockHiddenInCompact(b, message, renderConfig);
          if (hidden) {
            pendingHidden.push({ block: b, origIdx: i, vIdx });
            vIdx++;
          } else {
            flush();
            const node = renderWrappedBlock(b, vIdx, i);
            vIdx++;
            if (node !== null) {
              renderedSomething = true;
              out.push(node);
            }
          }
        }
        flush();
        output = out;
      }

      const typedUsage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const usageNode = typedUsage ? (
        <div className="text-xs text-muted-foreground mt-2 px-1">
          Tokens: {typedUsage.input_tokens} in, {typedUsage.output_tokens} out
        </div>
      ) : null;

      if (!renderedSomething && !usageNode) return null;

      return (
        <>
          {output}
          {usageNode}
          <AssistantCompletionBand
            node={message}
            allMessages={streamMessages}
            index={assistantIndex}
            accountType={accountType}
          />
        </>
      );
    }

    // User message - handle both nested and direct content structures
    if (message.kind === "user") {
      const userRaw = message.raw;
      // Don't render meta messages — except skill-injected bodies, which
      // arrive with isMeta:true from JSONL but carry the SKILL.md content
      // we want to render. messageFilters has the same exemption upstream;
      // mirror it here so the renderer is correct on its own (defense-in-
      // depth in case filtering is bypassed).
      if (userRaw.isMeta && !detectSkillInjection(message, streamMessages)) {
        return null;
      }

      // Handle different message structures
      const msg = userRaw.message || userRaw;

      // Check if this is a tool-result-only message first — must happen before
      // bracket-detection to avoid tool results with nested content arrays
      // being misidentified as CLI system messages (the array coerces to
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
      // and hook feedback like "Stop hook feedback: ...") and route through
      // MessageFrame's `collapsible` presentation so it picks up the user's
      // configured color/icon and gains copy + raw-payload metadata. The
      // header is content-derived ("Skill: …", "CLAUDE.md Context") unless the
      // user has customized it in Appearance, in which case their label wins.
      if (isSystemContextText(contentStr)) {
        const cfgHeader = resolveKind(renderConfig, "user.systemContext").headerLabel ?? null;
        const headerOverride =
          cfgHeader === null || cfgHeader === "System Context"
            ? deriveSystemContextLabel(contentStr)
            : cfgHeader;
        return (
          <MessageFrame
            streamKind="user.systemContext"
            message={message}
            headerOverride={headerOverride}
            actionBar={<CardActionBar message={message} text={contentStr.trim()} />}
          >
            <pre className="text-xs font-mono whitespace-pre-wrap max-h-60 overflow-y-auto">
              {contentStr.trim()}
            </pre>
          </MessageFrame>
        );
      }

      // CLI-generated bracket messages like "[Request interrupted by user]"
      // or "[Session resumed]" come through as type:'user' but aren't the
      // user's words. Detect them (content is a single string wrapped in
      // square brackets) and render as a system notification so they're
      // visible but visually distinct from the user's actual input.
      // Skip tool-result messages — they are handled below.
      if (!isToolResultOnly) {
        const trimmed = contentStr.trim();
        const isSdkSystemMessage = trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.length < 200;
        if (isSdkSystemMessage) {
          // Strip the brackets and route through MessageFrame so Appearance
          // config controls the chrome (icon, accent, presentation).
          const inner = trimmed.slice(1, -1);
          return (
            <MessageFrame streamKind="user.sdkSystemBracket" message={message}>
              <span className="text-xs font-mono">{inner}</span>
            </MessageFrame>
          );
        }
      }

      // Check if this is a subagent prompt — a user message generated by
      // the Agent tool, not typed interactively. parent_tool_use_id is
      // non-null when the CLI is inside a subagent context. We render
      // these with an amber/yellow tint + Bot icon so they're visually
      // distinct from the user's own purple messages AND from tool results.
      const isSubagentPrompt = !isToolResultOnly
        && (userRaw as unknown as { parent_tool_use_id?: unknown }).parent_tool_use_id != null;

      const skillInjection = !isToolResultOnly && !isSubagentPrompt
        ? detectSkillInjection(message, streamMessages)
        : null;

      let renderedSomething = false;

      // Pick card style from the configurable palette. Every variant now has
      // a dedicated kind id so Appearance customizations apply uniformly.
      const isCommand = !isToolResultOnly && !isSubagentPrompt && !skillInjection
        && contentStr.includes('<command-name>');
      const isCommandOutput = !isToolResultOnly && !isSubagentPrompt && !skillInjection
        && !isCommand
        && contentStr.includes('<local-command-stdout>');
      const userKindId = isToolResultOnly
        ? "user.tool-result"
        : isSubagentPrompt
        ? "user.subagentPrompt"
        : skillInjection
        ? "user.skillInjection"
        : isCommand
        ? "user.command"
        : isCommandOutput
        ? "user.commandOutput"
        : "user.prompt";

      const userSwatch = swatchFor(renderConfig, userKindId);
      const showResend = !!onResend && !isToolResultOnly && !isSubagentPrompt && !skillInjection;
      const userActionBar = !isToolResultOnly ? (
        <CardActionBar
          message={msg}
          ariaLabel="User message actions"
          extras={showResend && onResend ? <ResendExtra msg={msg} onResend={onResend} /> : undefined}
        />
      ) : (
        <CardActionBar message={msg} />
      );

      // MessageFrame reads alignment, icon, accent, and header from config.
      // We only need to pass the body content as children.
      const streamKind = userKindId;
      const renderedCard = (
        <MessageFrame streamKind={streamKind} message={message} actionBar={userActionBar}>
          {/* Skill injection label */}
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
                          // Render markdown the same way assistant text does, so
                          // System Context / skill-injection bodies (and any other
                          // user-role text) render properly instead of printing
                          // raw markdown — and a fenced ```markdown block gets the
                          // Rendered/Source tabbed control via buildMarkdownComponents.
                          <div className="prose prose-sm dark:prose-invert max-w-none">
                            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={mdComponents}>
                              {textWithoutImages}
                            </ReactMarkdown>
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
                        const prevNode = streamMessages[i];
                        if (prevNode.kind !== 'assistant') continue;
                        const prevContent = prevNode.raw.message?.content;
                        if (!Array.isArray(prevContent)) continue;
                        // Narrow each block via shape so BetaToolUseBlock's
                        // `name` / `input` are reachable without `as any`.
                        const toolUse = (prevContent as unknown[]).find(
                          (c): c is { type: 'tool_use'; id?: string; name: string; input?: unknown } =>
                            (c as { type?: string }).type === 'tool_use' &&
                            (c as { id?: string }).id === content.tool_use_id,
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
                          <KindHeader kindId="user.tool-result" fallbackLabel="Tool Result" />

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
                          <KindHeader kindId="user.tool-result" fallbackLabel="Edit Result" />
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
                          <KindHeader kindId="user.tool-result" fallbackLabel="MultiEdit Result" />
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
                          const prevNode = streamMessages[i];
                          if (prevNode.kind !== 'assistant') continue;
                          const prevContent = prevNode.raw.message?.content;
                          if (!Array.isArray(prevContent)) continue;
                          const toolUse = (prevContent as MessageContentBlock[]).find((c) =>
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
                          <KindHeader kindId="user.tool-result" fallbackLabel="Directory Contents" />
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
                          const prevNode = streamMessages[i];
                          if (prevNode.kind !== 'assistant') continue;
                          const prevContent = prevNode.raw.message?.content;
                          if (!Array.isArray(prevContent)) continue;
                          const toolUse = (prevContent as unknown[]).find(
                            (c): c is { type: 'tool_use'; id?: string; name?: string; input?: unknown } =>
                              (c as { type?: string }).type === 'tool_use' &&
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
                      
                      renderedSomething = true;
                      return (
                        <div key={idx} className="space-y-2">
                          <KindHeader kindId="user.tool-result" fallbackLabel="Read Result" />
                          <ReadResultWidget content={contentText} filePath={filePath} />
                        </div>
                      );
                    }

                    // Handle empty tool results
                    if (!contentText || contentText.trim() === '') {
                      renderedSomething = true;
                      return (
                        <div key={idx} className="space-y-2">
                          <KindHeader kindId="user.tool-result" fallbackLabel="Tool Result" />
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
                          ? <KindHeader kindId="system.api_error" fallbackLabel="Tool Error" fallbackIcon="AlertCircle" showIcon />
                          : <KindHeader kindId="user.tool-result" fallbackLabel="Tool Result" />}
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
        </MessageFrame>
      );
      if (!renderedSomething) return null;
      return renderedCard;
    }

    // All other kinds (attachment, queue-operation, etc.) — nothing to render.
    return null;
  } catch (error) {
    // If any error occurs during rendering, show a safe error message
    console.error("Error rendering stream message:", error, message);
    return (
      <MessageFrame streamKind="unknown">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <p className="text-sm font-medium">Error rendering message</p>
            <p className="text-xs text-muted-foreground mt-1">
              {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </div>
        </div>
      </MessageFrame>
    );
  }
};

export const StreamMessage = React.memo(StreamMessageComponent);
