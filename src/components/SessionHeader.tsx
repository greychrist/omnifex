import { AccountBadge } from "./AccountBadge";
import { Copy, MapPin, Info, Database, ShieldCheck, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionAccountInfo, SessionContextUsage } from "@/lib/api";

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
  /**
   * The SDK's own account-info report fetched via query.accountInfo() after
   * the session initialized. Undefined before the call resolves; null if it
   * failed. When present, rendered as a small verification indicator next to
   * the account badge — this is the authoritative proof that the CLI
   * subprocess bound to the account we resolved from the project path.
   */
  sdkAccount?: SessionAccountInfo | null;
  /**
   * Authoritative context-window usage from query.getContextUsage(), fetched
   * at session init and at the end of every turn. When present, the widget
   * uses totalTokens/maxTokens/categories from this object instead of the
   * client-side (totalTokens / hardcoded limit) approximation — which gives
   * real numbers for system prompt, tools, memory, MCP, etc. rather than
   * just the assistant-reported message-token count.
   */
  contextUsage?: SessionContextUsage | null;
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
  sdkAccount,
  contextUsage,
  className,
}: SessionHeaderProps) {
  const copySessionId = () => {
    if (sessionId) {
      navigator.clipboard.writeText(sessionId);
    }
  };

  // Derive a human-friendly identifier for the SDK-reported account and
  // decide whether it agrees with our resolved account. Agreement is noisy
  // because Greg's local accounts are named "Personal" / "Work" while the
  // SDK reports email / org — we treat "reported something" as confirmation
  // unless the apiProvider indicates an unexpected backend.
  const sdkIdentifier =
    sdkAccount?.email ??
    sdkAccount?.organization ??
    sdkAccount?.subscriptionType ??
    null;
  const sdkVerified = sdkAccount !== undefined && sdkAccount !== null && Boolean(sdkIdentifier);
  const sdkMismatch =
    sdkAccount !== undefined &&
    sdkAccount !== null &&
    sdkAccount.apiProvider !== undefined &&
    sdkAccount.apiProvider !== 'firstParty';

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

      {/* Wave 2.1 — SDK-reported account verification indicator. A shield
          with check confirms the CLI subprocess is actually bound to
          something; a shield with alert indicates a third-party API
          backend (Bedrock/Vertex/etc.) which means this session isn't
          running against the Anthropic account we resolved. */}
      {sdkVerified && !sdkMismatch && (
        <div
          className="flex items-center gap-1 text-green-400/80"
          title={`SDK-reported account: ${sdkIdentifier}${
            sdkAccount?.subscriptionType ? ` (${sdkAccount.subscriptionType})` : ''
          }`}
        >
          <ShieldCheck className="w-3 h-3" />
          <span className="text-[10px] font-mono truncate max-w-[140px]">{sdkIdentifier}</span>
        </div>
      )}
      {sdkMismatch && (
        <div
          className="flex items-center gap-1 text-yellow-400"
          title={`SDK is using API provider: ${sdkAccount?.apiProvider}. This session is not on a first-party Anthropic account.`}
        >
          <ShieldAlert className="w-3 h-3" />
          <span className="text-[10px] uppercase tracking-wide">{sdkAccount?.apiProvider}</span>
        </div>
      )}

      <div className="flex items-center gap-1 text-foreground/40" title={configDir}>
        <MapPin className="w-3 h-3" />
        <span className="truncate max-w-[200px] font-mono">{configDir.replace(/^\/Users\/[^/]+/, '~')}</span>
      </div>

      <div className="flex items-center gap-1 text-foreground/40" title={matchDetail}>
        <Info className="w-3 h-3" />
        <span>Matched by: {matchLabel}</span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        {(() => {
          // Prefer authoritative numbers from query.getContextUsage() when
          // present; otherwise fall back to the old client-side approximation
          // (messages totalTokens / hardcoded context limit for the model).
          const useSdk = contextUsage !== undefined && contextUsage !== null;
          const tokens = useSdk ? contextUsage!.totalTokens : totalTokens;
          const limit = useSdk
            ? contextUsage!.maxTokens
            : model?.includes("[1m]")
            ? 1_000_000
            : 200_000;
          if (tokens <= 0 || limit <= 0) return null;
          const pct = Math.min(100, (tokens / limit) * 100);
          const color = pct > 80 ? "text-red-400" : pct > 50 ? "text-yellow-400" : "text-foreground/50";

          // Tooltip: detailed breakdown from the SDK when available, plain
          // totals when not.
          const breakdown = useSdk && contextUsage!.categories.length > 0
            ? contextUsage!.categories
                .slice()
                .sort((a, b) => b.tokens - a.tokens)
                .map((c) => `${c.name}: ${c.tokens.toLocaleString()}`)
                .join("\n")
            : null;
          const titleText = useSdk
            ? `${tokens.toLocaleString()} / ${(limit / 1000).toFixed(0)}k tokens (${pct.toFixed(1)}%)${
                breakdown ? `\n\n${breakdown}` : ''
              }\n\nsource: query.getContextUsage()`
            : `${tokens.toLocaleString()} / ${(limit / 1000).toFixed(0)}k tokens (${pct.toFixed(1)}%)\n\nsource: client-side estimate (totalTokens / ${(limit / 1000).toFixed(0)}k)`;

          return (
            <div className="flex items-center gap-1.5" title={titleText}>
              <Database className={cn("w-3 h-3", useSdk ? "text-foreground/60" : "text-foreground/30")} />
              <span className={cn("font-mono", color)}>
                {tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens}
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
