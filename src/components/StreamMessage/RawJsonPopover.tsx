import React, { useState } from "react";
import { Check, Copy, Eye } from "lucide-react";
import { Popover } from "@/components/ui/popover";
import { fireAndLog } from "@/lib/fireAndLog";

interface RawJsonPopoverProps {
  /** Already-serialized payload. Rendered verbatim and copied verbatim. */
  text: string;
  /** Panel heading. Defaults to "Raw JSON". */
  label?: string;
}

/**
 * The message card footer's payload affordance: opens a scrollable panel
 * showing the raw wire payload, with a copy button inside it.
 *
 * This used to be a bare copy button, which made "what is actually in this
 * record?" a question you could only answer by copying it somewhere else
 * first. Reading the payload is the common case — copying it is the
 * occasional one — so the trigger views and the panel copies.
 *
 * Chrome comes from the shared `Popover` (portal, click-outside, escape,
 * viewport clamping); this passes `p-0` and supplies its own header/body so
 * the heading sits flush against the panel edge the way other panels do.
 */
export const RawJsonPopover: React.FC<RawJsonPopoverProps> = ({ text, label = "Raw JSON" }) => {
  const [copied, setCopied] = useState(false);

  if (!text) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 1200);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const trigger = (
    <button
      type="button"
      className="p-0.5 rounded hover:bg-muted/60 hover:text-foreground transition-colors"
      title="View raw JSON"
      aria-label="View raw JSON"
    >
      <Eye className="w-3 h-3" />
    </button>
  );

  const content = (
    <div className="w-[560px] max-w-[85vw]">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
        <span className="text-[11px] font-mono text-foreground/80 select-none">{label}</span>
        <button
          type="button"
          onClick={fireAndLog("raw-json-popover:copy", handleCopy)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-border text-[10px] font-mono text-foreground/80 hover:bg-muted/60 hover:text-foreground transition-colors"
          title={copied ? "Copied!" : "Copy"}
          aria-label="Copy"
        >
          {copied
            ? <><Check className="w-3 h-3 text-green-500" /><span>Copied</span></>
            : <><Copy className="w-3 h-3" /><span>Copy</span></>}
        </button>
      </div>
      {/* The payload is unbounded in both axes — a long record would run off
          the viewport, and a single long line would widen the panel past it.
          Cap the height and scroll; wrap rather than scroll horizontally. */}
      <div className="max-h-[60vh] overflow-y-auto px-3 py-2">
        <pre
          data-testid="raw-json-body"
          className="text-[10px] leading-relaxed font-mono text-foreground/90 whitespace-pre-wrap break-words"
        >
          {text}
        </pre>
      </div>
    </div>
  );

  return (
    <Popover
      trigger={trigger}
      content={content}
      className="p-0 overflow-hidden"
      side="top"
      align="start"
    />
  );
};
