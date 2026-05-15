import React, { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { extractCopyText } from "@/lib/messageCopy";
import { logAndForget } from "@/lib/fireAndLog";

/**
 * The shared action bar that sits at the top-right of every message card.
 *
 * Before this consolidation, three components rendered nearly the same
 * thing with subtly different state and visuals: `CopyCardButton` (with a
 * "Copied" toast popup), `UserMessageActions` (no toast, just checkmark),
 * and the debug copy chip in `MessageCard`. They drifted apart and one
 * (`CopyCardButton`) never worked on result cards because its copy
 * helper only walked the `content` block array — result messages keep
 * their body on `result`/`errors` instead. The unified extractor lives
 * in `src/lib/messageCopy.ts`.
 *
 * Behavior contract:
 * - Always-visible outlined bar on `bg-background` (chat surface).
 * - Copy button always present when a copy target exists (either an
 *   explicit `text` prop or a `message` we can extract from).
 * - Successful copy swaps the icon to a green checkmark for ~2s. No
 *   floating "Copied" toast — the in-place state change is the feedback.
 * - Additional buttons (e.g. Resend on user messages) plug in through
 *   the `extras` slot using the matching `CardActionDivider` /
 *   `CardActionButton` primitives so every action reads as one family.
 */
interface CardActionBarProps {
  /** Underlying SDK message; used by `extractCopyText` when `text` is omitted. */
  message?: unknown;
  /** Explicit text to copy. Takes precedence over message-based extraction. */
  text?: string;
  /** Optional buttons rendered after the Copy button. Use
   *  `CardActionDivider` between buttons for the segmented-control look. */
  extras?: React.ReactNode;
  /** Accessible label for the toolbar. Defaults to "Message actions". */
  ariaLabel?: string;
}

export const CardActionBar: React.FC<CardActionBarProps> = ({
  message,
  text,
  extras,
  ariaLabel = "Message actions",
}) => {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const copyText = text ?? (message ? extractCopyText(message) : '');
    if (!copyText) return;
    logAndForget('card-action-bar:copy', navigator.clipboard.writeText(copyText));
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = null;
    }, 2000);
  };

  return (
    <div
      className="absolute top-1 right-1 inline-flex items-center rounded-md border border-border bg-background overflow-hidden z-10"
      role="toolbar"
      aria-label={ariaLabel}
    >
      <CardActionButton
        onClick={handleCopy}
        title={copied ? "Copied!" : "Copy content"}
        ariaLabel="Copy content"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      </CardActionButton>
      {extras}
    </div>
  );
};

/** Hairline divider between buttons inside a `CardActionBar`. */
export const CardActionDivider: React.FC = () => (
  <span className="h-4 w-px bg-border" aria-hidden />
);

/** Single action button matching the bar's button shape. */
export const CardActionButton: React.FC<{
  onClick: (e: React.MouseEvent) => void;
  title: string;
  ariaLabel: string;
  children: React.ReactNode;
}> = ({ onClick, title, ariaLabel, children }) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex items-center justify-center h-6 w-6 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
    title={title}
    aria-label={ariaLabel}
  >
    {children}
  </button>
);
