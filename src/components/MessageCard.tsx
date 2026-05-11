import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
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
import type { ClaudeStreamMessage } from "@/types/claudeStream";
import type { IconName } from "@/lib/messageRenderingConfig";

interface MessageCardProps {
  /** Drives icon, accent, and (via KindHeader) the configured header label.
   *  Must match an entry in DEFAULT_KINDS. */
  kindId: string;
  /** The underlying SDK message — used to read `receivedAt` for the
   *  timestamp footer and to feed the debug-mode raw-JSON copy button. */
  message?: ClaudeStreamMessage;
  /** Card body — the only thing that varies between kinds. Wrap whatever
   *  type-specific rendering belongs in this card. */
  children: React.ReactNode;
  /** Used when the kind has no `headerLabel` set in config — pass null to
   *  suppress the header row entirely (e.g. a card whose body is the
   *  header, like a permission prompt). */
  headerFallbackLabel?: string | null;
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
}

/**
 * Shared shell for every message card in the timeline. Owns the chrome —
 * accent border, leading icon, KindHeader (which reads the user-configured
 * label from Appearance settings), bottom timestamp, and debug raw-JSON
 * label/copy. Body content is the children.
 *
 * Migrating a kind to MessageCard means: pick a kindId, pass `message`,
 * and put whatever was previously inside the inline `<Card><CardContent>...`
 * tree into `children`. Per-kind overrides (icon, accent, header label,
 * compact-mode visibility) all flow through the existing config without
 * any per-call wiring.
 */
export const MessageCard: React.FC<MessageCardProps> = ({
  kindId,
  message,
  children,
  headerFallbackLabel = null,
  iconOverride,
  showHeaderIcon = false,
  alignment = "left",
  widthClassName,
  className,
  copyText,
}) => {
  const { config } = useMessageRenderingConfig();
  const accentStyle = accentStyleFor(config, kindId);
  const swatch = swatchFor(config, kindId);
  const iconName = iconOverride ?? iconNameFor(config, kindId) ?? "none";

  const justify =
    alignment === "right"
      ? "justify-end"
      : alignment === "full"
        ? "justify-center"
        : "justify-start";

  const width = widthClassName ?? (alignment === "full" ? "w-full" : "w-[95%]");

  return (
    <div className={cn("flex", justify)}>
      <Card
        className={cn("border relative", width, className)}
        style={accentStyle}
      >
        <CardContent className="p-4 pb-9">
          <div className="flex items-start gap-3">
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
            <div className="flex-1 space-y-2 min-w-0 overflow-x-auto">
              <KindHeader
                kindId={kindId}
                fallbackLabel={headerFallbackLabel}
                showIcon={showHeaderIcon}
              />
              {children}
            </div>
          </div>
        </CardContent>
        <CardFooter receivedAt={message?.receivedAt} message={message} copyText={copyText} />
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
  message?: ClaudeStreamMessage;
  copyText?: string;
}> = ({ receivedAt, message, copyText }) => {
  const { config } = useMessageRenderingConfig();
  const [copied, setCopied] = useState(false);
  const formatted = receivedAt ? formatLocalTimestamp(receivedAt) : null;

  const showKind = config.debug.showCardKindLabel && message;
  let kindLabel: string | null = null;
  if (showKind) {
    const t = message?.type ?? null;
    const sub = message?.subtype ?? null;
    if (t) kindLabel = sub ? `${t} · ${sub}` : String(t);
  }

  const handleCopy = async () => {
    try {
      const text = copyText ?? (message ? JSON.stringify(message, null, 2) : "");
      if (!text) return;
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
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
          title="SDK message type · subtype"
        >
          <span className="pointer-events-none">{kindLabel}</span>
          {(message || copyText) && (
            <button
              type="button"
              onClick={handleCopy}
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
