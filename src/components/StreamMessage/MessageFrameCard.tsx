import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { accentStyleFor, swatchFor } from "@/lib/accentStyle";
import { iconNameFor } from "@/lib/kindPresentation";
import {
  iconSizeClassName,
  iconWrapperClassName,
  iconWrapperStyle,
} from "@/lib/typographyClasses";
import { IconRenderer } from "@/components/settings-panels/appearance/iconMap";
import { KindHeader } from "@/components/KindHeader";
import type { JsonlNode } from "@/types/jsonl";
import type { BorderStyle, IconName } from "@/lib/messageRenderingConfig";
import { fireAndLog } from "@/lib/fireAndLog";

interface MessageFrameCardProps {
  /** Drives icon, accent, and (via KindHeader) the configured header label.
   *  Must match an entry in DEFAULT_KINDS. */
  kindId: string;
  /** The underlying stream node — used to read `receivedAt` for the
   *  timestamp footer and to feed the debug-mode raw-JSON copy button. */
  message?: JsonlNode;
  /** Card body — the only thing that varies between kinds. Wrap whatever
   *  type-specific rendering belongs in this card. */
  children: React.ReactNode;
  /** Used when the kind has no `headerLabel` set in config — pass null to
   *  suppress the header row entirely (e.g. a card whose body is the
   *  header, like a permission prompt). */
  headerFallbackLabel?: string | null;
  /** Overrides the kind's configured `headerLabel`. Use for variants that
   *  borrow another kind's chrome but carry a specific fixed label (e.g.
   *  AnsweredAskUserQuestionCard reuses `permission.askUserQuestion`
   *  chrome but renders "Question answered" / "N questions answered"). */
  headerLabel?: string | null;
  /** Override the kind's icon when the variant needs a tighter signal
   *  (e.g. error states). */
  iconOverride?: IconName;
  /** When true, render the inline icon next to the header label. */
  showHeaderIcon?: boolean;
  /** Card alignment: "left" (assistant/system), "right" (user prompts),
   *  or "full" (system-wide). Defaults to "left". */
  alignment?: "left" | "right" | "full";
  /** Width as a tailwind fragment (e.g. "max-w-[95%]"). Defaults to a
   *  comfortable left-aligned bubble width. */
  widthClassName?: string;
  /** Extra classes for the outer Card. */
  className?: string;
  /** When provided, enables the small copy-to-clipboard button on the
   *  card's top-right (writes this text). When omitted and `message` is
   *  set, the debug footer's raw-JSON copy button is used instead. */
  copyText?: string;
  /** Override the border-style on the card chrome. Defaults to the value
   *  in the kind config (usually `solid`). Pass explicitly when the caller
   *  needs to diverge from config (e.g. `dashed` for the unknown fallback). */
  borderStyle?: BorderStyle;
  /** Optional toolbar node rendered absolutely inside the card (top-right).
   *  Use this to attach a `CardActionBar` to the card. The card applies
   *  `group/card relative` so the bar can position itself with
   *  `absolute top-1 right-1`. */
  actionBar?: React.ReactNode;
}

/**
 * Shared shell for every message card in the timeline. Owns the chrome —
 * accent border, leading icon, KindHeader (which reads the user-configured
 * label from Appearance settings), bottom timestamp, and debug raw-JSON
 * label/copy. Body content is the children.
 *
 * Migrating a kind to MessageFrameCard means: pick a kindId, pass `message`,
 * and put whatever was previously inside the inline `<Card><CardContent>...`
 * tree into `children`. Per-kind overrides (icon, accent, header label,
 * compact-mode visibility) all flow through the existing config without
 * any per-call wiring.
 */
export const MessageFrameCard: React.FC<MessageFrameCardProps> = ({
  kindId,
  message,
  children,
  headerFallbackLabel = null,
  headerLabel,
  iconOverride,
  showHeaderIcon = false,
  alignment = "left",
  widthClassName,
  className,
  copyText,
  borderStyle,
  actionBar,
}) => {
  const { config } = useMessageRenderingConfig();
  const accentStyle = accentStyleFor(config, kindId);
  const swatch = swatchFor(config, kindId);
  const iconName = iconOverride ?? iconNameFor(config, kindId) ?? "none";
  // Resolve borderStyle: explicit prop > kind config > 'solid'
  const resolvedBorderStyle =
    borderStyle ?? config.kinds[kindId]?.borderStyle ?? 'solid';

  const justify =
    alignment === "right"
      ? "justify-end"
      : alignment === "full"
        ? "justify-center"
        : "justify-start";

  // Right-aligned cards (e.g. user.prompt) shrink so the right-alignment is
  // visually meaningful — at 95% the card would still span almost the full
  // surface and right vs. left would be indistinguishable. Left and full
  // keep the existing widths.
  const width =
    widthClassName ?? (
      alignment === "full" ? "w-full"
      : alignment === "right" ? "max-w-[75%] w-fit"
      : "w-[95%]"
    );

  return (
    <div className={cn("flex", justify)}>
      <Card
        className={cn("border relative group/card", width, className)}
        style={{ ...accentStyle, borderStyle: resolvedBorderStyle }}
      >
        {actionBar}
        {/* Outer flex: leading icon chip on the left, header + content
            stacked on the right. CardHeader and CardContent give the right
            column proper structural separation (their own padding boxes +
            the explicit pb-9 on the content's last child for the absolute
            footer). The shadcn defaults of `p-6` are overridden here so the
            card stays compact in the chat timeline. */}
        <div className="flex items-start gap-3 px-4 pt-4">
          {iconName !== "none" && (
            <div
              className={iconWrapperClassName(config, kindId)}
              style={iconWrapperStyle(config, swatch, kindId)}
            >
              <IconRenderer
                name={iconName}
                className={iconSizeClassName(config, kindId)}
              />
            </div>
          )}
          <div className="flex-1 min-w-0 overflow-x-auto">
            <CardHeader className="p-0 space-y-0">
              <KindHeader
                kindId={kindId}
                label={headerLabel}
                fallbackLabel={headerFallbackLabel}
                showIcon={showHeaderIcon}
              />
            </CardHeader>
            <CardContent className="p-0 pb-9">
              {children}
            </CardContent>
          </div>
        </div>
        <CardFooter receivedAt={(message as { receivedAt?: string } | undefined)?.receivedAt} message={message} copyText={copyText} kindId={kindId} />
      </Card>
    </div>
  );
};

// ─── footer ────────────────────────────────────────────────────────────────

function formatLocalTimestamp(isoOrNumeric: string): string {
  const d = new Date(isoOrNumeric);
  if (Number.isNaN(d.getTime())) return isoOrNumeric;
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  let h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const mins = String(d.getMinutes()).padStart(2, "0");
  const secs = String(d.getSeconds()).padStart(2, "0");
  return `${m}/${day}/${yy} ${h}:${mins}:${secs} ${ampm}`;
}

const CardFooter: React.FC<{
  receivedAt?: string;
  message?: JsonlNode;
  copyText?: string;
  kindId?: string;
}> = ({ receivedAt, message, copyText, kindId }) => {
  const [copied, setCopied] = useState(false);
  const formatted = receivedAt ? formatLocalTimestamp(receivedAt) : null;

  // Kind label shows the resolved catalog kind ID broken on its dots so the
  // full taxonomy is visible — e.g. `assistant.text.endTurn` reads as
  // "assistant · text · endTurn" (origin · subtype · modifier). For
  // non-dotted kinds (e.g. `cli-stream-init`, `unknown`) the single segment
  // renders as-is. Falls back to the raw envelope's type/subtype only when
  // no kindId is provided (defensive — every caller should pass one).
  let kindLabel: string | null = null;
  if (typeof kindId === 'string' && kindId.length > 0) {
    kindLabel = kindId.split('.').join(' · ');
  } else if (message) {
    const raw = (message as unknown as { raw?: { type?: string; subtype?: string } }).raw ?? {};
    const t = raw.type;
    const sub = typeof raw.subtype === 'string' ? raw.subtype : null;
    if (t) kindLabel = sub ? `${t} · ${sub}` : String(t);
  }

  const handleCopy = async () => {
    try {
      // Serialize the raw wire payload for the copy button.
      const text = copyText ?? (message ? JSON.stringify((message as unknown as { raw?: unknown }).raw, null, 2) : "");
      if (!text) return;
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 1200);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  if (!formatted && !kindLabel) return null;

  return (
    <>
      {kindLabel && (
        <div
          className="absolute bottom-1 left-2 flex items-center gap-1.5 px-1.5 py-0.5 rounded-md border bg-background text-[10px] text-foreground/80 font-mono select-none"
          title="message type · subtype"
        >
          <span className="pointer-events-none">{kindLabel}</span>
          {(message || copyText) && (
            <button
              type="button"
              onClick={fireAndLog('message-card:click', handleCopy)}
              className="p-0.5 rounded hover:bg-muted/60 hover:text-foreground transition-colors"
              title={copied ? "Copied!" : "Copy"}
              aria-label="Copy"
            >
              {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
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

// ─── back-compat aliases ───────────────────────────────────────────────────

export const MessageCard = MessageFrameCard;
export type MessageCardProps = MessageFrameCardProps;
