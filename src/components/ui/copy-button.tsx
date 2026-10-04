import React, { useEffect, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { fireAndLog } from "@/lib/fireAndLog";

interface CopyButtonProps {
  /** Read at click time, so the text is whatever the block holds then. */
  getText: () => string;
  /** Accessible name and resting tooltip. */
  label?: string;
  /** Visible text beside the icon, for buttons that sit in a labelled bar. */
  text?: string;
  className?: string;
}

/**
 * Copy-to-clipboard icon button: `Copy`, then `Check` for 1.2s once the
 * write lands. A failed write (no clipboard in an insecure context — the
 * remote client over plain HTTP) is logged and leaves the icon alone.
 */
export const CopyButton: React.FC<CopyButtonProps> = ({ getText, label = "Copy", text, className }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(getText());
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, 1200);
    } catch (err) {
      console.error("Copy failed:", err);
    }
  };

  return (
    <button
      type="button"
      onClick={fireAndLog("copy-button:click", handleCopy)}
      aria-label={label}
      title={copied ? "Copied!" : label}
      className={cn(
        "p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {text && <span>{text}</span>}
    </button>
  );
};
