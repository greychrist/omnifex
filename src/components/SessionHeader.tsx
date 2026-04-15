import * as React from "react";
import { AccountBadge } from "./AccountBadge";
import {
  Copy,
  Database,
  GitBranch,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionAccountInfo, SessionContextUsage } from "@/lib/api";
import { Popover } from "@/components/ui/popover";
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
  /** Session status indicator — 'active' (subprocess alive) | 'ended' (no subprocess) */
  sessionStatus?: 'active' | 'ended';
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
  effortLevel?: string;
  thinkingConfig?: string;
  permissionMode?: string;
  gitBranch?: string;

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
  effortLevel,
  thinkingConfig,
  permissionMode,
  sessionStatus,
  gitBranch,
  className,
}: SessionHeaderProps) {
  // Local open state for the two Popovers so they're click-driven and
  // we control close-on-select etc.
  const [accountPopoverOpen, setAccountPopoverOpen] = React.useState(false);
  const [contextPopoverOpen, setContextPopoverOpen] = React.useState(false);

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

      {/* Session status indicator */}
      {sessionStatus && (
        <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className={cn(
            "h-2 w-2 rounded-full",
            sessionStatus === 'active' ? 'bg-emerald-500' : 'bg-red-500',
          )} />
          {sessionStatus === 'active' ? 'Active' : 'Closed'}
        </span>
      )}

      {/* SDK account email — clickable to show account details popover */}
      {sdkIdentifier && (
        <Popover
          open={accountPopoverOpen}
          onOpenChange={setAccountPopoverOpen}
          align="start"
          side="bottom"
          className="w-96"
          trigger={
            <button
              type="button"
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded-md hover:bg-foreground/10 transition-colors",
                sdkMismatch ? "text-yellow-400" : "text-green-400/80",
              )}
              title="Click for account details"
            >
              {sdkMismatch ? <ShieldAlert className="w-3 h-3" /> : <ShieldCheck className="w-3 h-3" />}
              <span className="text-[10px] font-mono truncate max-w-[140px]">{sdkIdentifier}</span>
            </button>
          }
          content={
            <div className="flex flex-col gap-3 text-left">
              {sdkAccount && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
                    {sdkMismatch ? (
                      <ShieldAlert className="w-3 h-3 text-yellow-400" />
                    ) : (
                      <ShieldCheck className="w-3 h-3 text-green-400" />
                    )}
                    SDK-reported account
                  </div>
                  <div className="flex flex-col gap-1 text-xs">
                    {sdkAccount.email && (
                      <div className="flex justify-between gap-2">
                        <span className="text-foreground/50">Email</span>
                        <span className="font-mono text-foreground/90 truncate">{sdkAccount.email}</span>
                      </div>
                    )}
                    {sdkAccount.organization && (
                      <div className="flex justify-between gap-2">
                        <span className="text-foreground/50">Organization</span>
                        <span className="font-mono text-foreground/90 truncate">{sdkAccount.organization}</span>
                      </div>
                    )}
                    {sdkAccount.subscriptionType && (
                      <div className="flex justify-between gap-2">
                        <span className="text-foreground/50">Subscription</span>
                        <span className="font-mono text-foreground/90 uppercase">{sdkAccount.subscriptionType}</span>
                      </div>
                    )}
                    {sdkAccount.apiProvider && (
                      <div className="flex justify-between gap-2">
                        <span className="text-foreground/50">API provider</span>
                        <span className={cn("font-mono", sdkMismatch ? "text-yellow-400" : "text-foreground/90")}>
                          {sdkAccount.apiProvider}
                        </span>
                      </div>
                    )}
                    {sdkAccount.tokenSource && (
                      <div className="flex justify-between gap-2">
                        <span className="text-foreground/50">Token source</span>
                        <span className="font-mono text-foreground/90">{sdkAccount.tokenSource}</span>
                      </div>
                    )}
                    {sdkAccount.apiKeySource && (
                      <div className="flex justify-between gap-2">
                        <span className="text-foreground/50">API key source</span>
                        <span className="font-mono text-foreground/90">{sdkAccount.apiKeySource}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Config directory</div>
                <div className="font-mono text-xs break-all text-foreground/90">{configDir}</div>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Matched by</div>
                <div className="text-xs text-foreground/90 flex flex-col gap-0.5">
                  <span className="font-medium">{matchLabel}</span>
                  <span className="text-foreground/60 font-mono break-all">{matchDetail}</span>
                </div>
              </div>
            </div>
          }
        />
      )}

      {permissionMode && (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wide bg-foreground/5 text-foreground/50">
          {permissionMode === 'default' ? 'ask' : permissionMode === 'acceptEdits' ? 'auto-edit' : permissionMode === 'plan' ? 'plan' : permissionMode === 'bypassPermissions' ? 'yolo' : permissionMode}
        </span>
      )}
      {effortLevel && effortLevel !== 'auto' && (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wide bg-foreground/5 text-foreground/50">
          effort: {effortLevel}
        </span>
      )}
      {thinkingConfig && thinkingConfig !== 'adaptive' && (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wide bg-foreground/5 text-foreground/50">
          thinking: {thinkingConfig === 'disabled' ? 'off' : thinkingConfig}
        </span>
      )}
      {gitBranch && (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-foreground/5 text-foreground/50 flex items-center gap-1">
          <GitBranch className="w-3 h-3" />
          {gitBranch}
        </span>
      )}

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
          //
          // The SDK usually reports a "Free space" category itself, in which
          // case the sum of its categories already covers the full budget
          // and we must NOT synthesize our own Free slice — doing so would
          // double-count and split the donut in half.
          //
          // If the SDK's categories sum to less than maxTokens (older SDK
          // versions, or edge cases where deferred tokens are omitted) we
          // fill the remainder with a synthetic "Free" slice so the pie
          // still visualizes the total budget.
          const sortedCategories =
            useSdk && contextUsage!.categories.length > 0
              ? contextUsage!.categories
                  .slice()
                  .sort((a, b) => b.tokens - a.tokens)
                  .filter((c) => c.tokens > 0)
              : [];

          const categoriesSum = sortedCategories.reduce(
            (acc, c) => acc + c.tokens,
            0,
          );
          // Color assignment: "Free-like" categories get the slate backdrop
          // color, other (used) categories get palette entries in the order
          // they appear. Using a separate counter for non-free categories so
          // we don't waste the first palette color on Free space when it
          // happens to be the largest slice.
          const FREE_COLOR = "rgba(148, 163, 184, 0.35)"; // slate-400 @35%
          const isFreeCategory = (name: string) =>
            /free|remaining|available/i.test(name);
          let usedColorIdx = 0;
          const slicesFromCategories = sortedCategories.map((c) => {
            const free = isFreeCategory(c.name);
            const color = free
              ? FREE_COLOR
              : CATEGORY_COLORS[usedColorIdx++ % CATEGORY_COLORS.length];
            return { name: c.name, value: c.tokens, color };
          });
          const pieData =
            categoriesSum < limit
              ? [
                  ...slicesFromCategories,
                  {
                    name: "Free",
                    value: limit - categoriesSum,
                    color: FREE_COLOR,
                  },
                ]
              : slicesFromCategories;

          return (
            <Popover
              open={contextPopoverOpen}
              onOpenChange={setContextPopoverOpen}
              align="end"
              side="bottom"
              className="w-96"
              trigger={
                <div className="flex items-center gap-1.5 cursor-pointer">
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
              }
              content={
                <div className="flex flex-col gap-2 text-left">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-semibold">Context window</span>
                    <span className={cn("font-mono text-sm", color)}>
                      {pct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground font-mono">
                    {tokens.toLocaleString()} / {limit.toLocaleString()} tokens
                  </div>

                  {useSdk && sortedCategories.length > 0 && contextPopoverOpen ? (
                    <>
                      <div className="h-72 -mx-2">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={pieData}
                              dataKey="value"
                              nameKey="name"
                              cx="50%"
                              cy="50%"
                              innerRadius={76}
                              outerRadius={120}
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
                        {pieData.map((slice) => {
                          const catPct =
                            limit > 0 ? (slice.value / limit) * 100 : 0;
                          return (
                            <div
                              key={slice.name}
                              className="flex items-center gap-2 text-xs"
                            >
                              <span
                                className="inline-block w-2 h-2 rounded-sm shrink-0"
                                style={{ backgroundColor: slice.color }}
                              />
                              <span className="flex-1 truncate text-foreground/80">
                                {slice.name}
                              </span>
                              <span className="font-mono text-foreground/60 shrink-0">
                                {slice.value.toLocaleString()}
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
              }
            />
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
