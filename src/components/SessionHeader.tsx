import { AccountBadge } from "./AccountBadge";
import { Copy, MapPin, Info, Database, ShieldCheck, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionAccountInfo, SessionContextUsage } from "@/lib/api";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";

// Palette for context-usage categories. Each category comes with its own
// `color` from the SDK, but those default colors sometimes clash with our
// dark palette, so we override with our own sequence and fall back to the
// SDK color if we run out of slots.
const CATEGORY_COLORS = [
  "#60a5fa", // blue-400
  "#a78bfa", // violet-400
  "#34d399", // emerald-400
  "#fbbf24", // amber-400
  "#f472b6", // pink-400
  "#22d3ee", // cyan-400
  "#f87171", // red-400
  "#a3e635", // lime-400
];

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

          // Build pie-chart data from SDK categories (descending by tokens).
          // Add a "Free" slice representing the remaining context so the
          // chart visualizes the total budget, not just what's been used.
          const sortedCategories =
            useSdk && contextUsage!.categories.length > 0
              ? contextUsage!.categories
                  .slice()
                  .sort((a, b) => b.tokens - a.tokens)
                  .filter((c) => c.tokens > 0)
              : [];
          const remainingTokens = Math.max(0, limit - tokens);
          const pieData = [
            ...sortedCategories.map((c, i) => ({
              name: c.name,
              value: c.tokens,
              color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
            })),
            {
              name: "Free",
              value: remainingTokens,
              color: "rgba(255,255,255,0.08)",
            },
          ];

          return (
            <HoverCard openDelay={80} closeDelay={120}>
              <HoverCardTrigger asChild>
                <div className="flex items-center gap-1.5 cursor-default">
                  <Database
                    className={cn(
                      "w-3 h-3",
                      useSdk ? "text-foreground/60" : "text-foreground/30",
                    )}
                  />
                  <span className={cn("font-mono", color)}>
                    {tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens}
                  </span>
                  <div className="w-16 h-1.5 bg-foreground/10 rounded-full overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        pct > 80
                          ? "bg-red-400"
                          : pct > 50
                          ? "bg-yellow-400"
                          : "bg-primary/60",
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-foreground/30 font-mono">{pct.toFixed(0)}%</span>
                </div>
              </HoverCardTrigger>
              <HoverCardContent align="end" className="w-80">
                <div className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-semibold">Context window</span>
                    <span className={cn("font-mono text-sm", color)}>
                      {pct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground font-mono">
                    {tokens.toLocaleString()} / {limit.toLocaleString()} tokens
                  </div>

                  {useSdk && sortedCategories.length > 0 ? (
                    <>
                      <div className="h-36 -mx-2">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={pieData}
                              dataKey="value"
                              nameKey="name"
                              cx="50%"
                              cy="50%"
                              innerRadius={38}
                              outerRadius={60}
                              paddingAngle={1}
                              stroke="none"
                              isAnimationActive={false}
                            >
                              {pieData.map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={entry.color} />
                              ))}
                            </Pie>
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="flex flex-col gap-1">
                        {sortedCategories.map((c, i) => {
                          const catPct = limit > 0 ? (c.tokens / limit) * 100 : 0;
                          return (
                            <div
                              key={c.name}
                              className="flex items-center gap-2 text-xs"
                            >
                              <span
                                className="inline-block w-2 h-2 rounded-sm shrink-0"
                                style={{
                                  backgroundColor:
                                    CATEGORY_COLORS[i % CATEGORY_COLORS.length],
                                }}
                              />
                              <span className="flex-1 truncate text-foreground/80">
                                {c.name}
                              </span>
                              <span className="font-mono text-foreground/60 shrink-0">
                                {c.tokens.toLocaleString()}
                              </span>
                              <span className="font-mono text-foreground/40 shrink-0 w-10 text-right">
                                {catPct.toFixed(1)}%
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-muted-foreground italic">
                      Category breakdown not yet available — waiting for the SDK
                      to report per-category usage.
                    </div>
                  )}

                  <div className="pt-1 mt-1 border-t border-border/50 text-[10px] text-muted-foreground">
                    source:{" "}
                    {useSdk
                      ? "query.getContextUsage()"
                      : "client-side estimate (fallback)"}
                  </div>
                </div>
              </HoverCardContent>
            </HoverCard>
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
