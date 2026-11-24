import React, { useState } from "react";
import { Check, Copy, Eye } from "lucide-react";
import { Popover } from "@/components/ui/popover";
import { fireAndLog } from "@/lib/fireAndLog";

export type RawPayload = string | (() => string);

interface RawJsonPopoverProps {
  text: RawPayload;
  label?: string;
}

// A thunk is called only while the panel is open: eager serialization in every card footer cost ~5ms per stream delta. Keep the laziness.
export const RawJsonPopover: React.FC<RawJsonPopoverProps> = ({ text, label = "Raw JSON" }) => {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);

  // Never call the thunk to check for emptiness: that defeats the laziness.
  if (typeof text === "string" && !text) return null;

  const resolved = open ? (typeof text === "string" ? text : text()) : "";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(resolved);
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 1200);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const trigger = (
    <button
      type="button"
      className="inline-flex items-center justify-center h-6 w-6 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      title="View raw JSON"
      aria-label="View raw JSON"
    >
      <Eye className="h-3.5 w-3.5" />
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
      <div className="max-h-[60vh] overflow-y-auto px-3 py-2">
        <pre
          data-testid="raw-json-body"
          className="text-[10px] leading-relaxed font-mono text-foreground/90 whitespace-pre-wrap break-words"
        >
          {resolved}
        </pre>
      </div>
    </div>
  );

  return (
    <Popover
      trigger={trigger}
      content={content}
      open={open}
      onOpenChange={setOpen}
      triggerClassName="relative inline-flex"
      className="p-0 overflow-hidden"
      side="top"
      align="start"
    />
  );
};
