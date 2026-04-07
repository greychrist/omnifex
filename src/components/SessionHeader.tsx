import { AccountBadge } from "./AccountBadge";
import { Copy, MapPin, Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface SessionHeaderProps {
  accountName: string;
  accountType: string;
  configDir: string;
  matchType: string;
  matchDetail: string;
  sessionId: string | null;
  cost: number;
  className?: string;
}

export function SessionHeader({
  accountName,
  accountType,
  configDir,
  matchType,
  matchDetail,
  sessionId,
  cost,
  className,
}: SessionHeaderProps) {
  const copySessionId = () => {
    if (sessionId) {
      navigator.clipboard.writeText(sessionId);
    }
  };

  const matchLabel = matchType === "path_rule"
    ? "path rule"
    : matchType === "project_override"
    ? "project override"
    : "default";

  const showCost = accountType !== "max";

  return (
    <div className={cn(
      "flex items-center gap-3 px-4 py-2 border-b border-border/50 bg-background/50 text-xs shrink-0",
      className
    )}>
      <AccountBadge name={accountName} />
      <span className="text-foreground/50 uppercase tracking-wide">{accountType}</span>

      <div className="flex items-center gap-1 text-foreground/40" title={configDir}>
        <MapPin className="w-3 h-3" />
        <span className="truncate max-w-[200px] font-mono">{configDir.replace(/^\/Users\/[^/]+/, '~')}</span>
      </div>

      <div className="flex items-center gap-1 text-foreground/40" title={matchDetail}>
        <Info className="w-3 h-3" />
        <span>Matched by: {matchLabel}</span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        {showCost && (
          <span className="text-foreground/50 font-mono">
            ${cost.toFixed(4)}
          </span>
        )}
        {sessionId && (
          <button
            onClick={copySessionId}
            className="flex items-center gap-1 text-foreground/30 hover:text-foreground/60 transition-colors"
            title="Copy session ID"
          >
            <span className="font-mono truncate max-w-[80px]">{sessionId.slice(0, 8)}</span>
            <Copy className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}
