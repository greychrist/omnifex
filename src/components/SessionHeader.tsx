import { AccountBadge } from "./AccountBadge";
import { Copy, MapPin, Info, Database } from "lucide-react";
import { cn } from "@/lib/utils";

interface SessionHeaderProps {
  accountName: string;
  accountType: string;
  configDir: string;
  matchType: string;
  matchDetail: string;
  sessionId: string | null;
  cost: number;
  totalTokens: number;
  model?: string;
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
  totalTokens,
  model,
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
        {totalTokens > 0 && (() => {
          const contextLimit = model?.includes("[1m]") ? 1_000_000 : 200_000;
          const pct = Math.min(100, (totalTokens / contextLimit) * 100);
          const color = pct > 80 ? "text-red-400" : pct > 50 ? "text-yellow-400" : "text-foreground/50";
          return (
            <div className="flex items-center gap-1.5" title={`${totalTokens.toLocaleString()} / ${(contextLimit / 1000).toFixed(0)}k tokens (${pct.toFixed(1)}%)`}>
              <Database className="w-3 h-3 text-foreground/40" />
              <span className={cn("font-mono", color)}>
                {totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens}
              </span>
              <div className="w-16 h-1.5 bg-foreground/10 rounded-full overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all", pct > 80 ? "bg-red-400" : pct > 50 ? "bg-yellow-400" : "bg-primary/60")}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-foreground/30 font-mono">{pct.toFixed(0)}%</span>
            </div>
          );
        })()}
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
