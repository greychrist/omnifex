import { AccountBadge } from "./AccountBadge";
import {
  Copy,
  MapPin,
  Info,
  Database,
  ShieldCheck,
  ShieldAlert,
  ChevronDown,
  Check,
  Cpu,
  Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  SessionAccountInfo,
  SessionContextUsage,
  SessionModelInfo,
} from "@/lib/api";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";

// Wave 2.4b — the full set of SDK permission modes. We default to
// exposing a useful subset in the header dropdown. Users can always
// configure the full range through Claude Code directly.
const PERMISSION_MODE_OPTIONS: Array<{
  value: string;
  label: string;
  description: string;
}> = [
  { value: "default", label: "Ask each time", description: "Prompt before every tool use" },
  { value: "acceptEdits", label: "Auto-accept edits", description: "Read/Write/Edit are auto-approved" },
  { value: "plan", label: "Plan only", description: "No tool execution, plan-then-confirm" },
  { value: "bypassPermissions", label: "Auto-approve all", description: "Bypass every permission check (destructive ok)" },
];

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

  /**
   * Wave 2.5 — live model list fetched via query.supportedModels() once the
   * session is running. When non-empty, the header renders a model picker
   * populated from this list instead of a static label. onModelChange is
   * called with the model value when the user picks; the parent is
   * responsible for calling api.sessionSetModel() + updating its own state.
   */
  supportedModels?: SessionModelInfo[];
  onModelChange?: (model: string) => void;

  /**
   * Wave 2.4b — current permission mode + change callback. When provided,
   * the header renders a permission-mode dropdown next to the model picker.
   * The parent should wire onPermissionModeChange to api.sessionSetPermissionMode()
   * and mirror the result into its own state.
   */
  permissionMode?: string;
  onPermissionModeChange?: (mode: string) => void;

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
  supportedModels,
  onModelChange,
  permissionMode,
  onPermissionModeChange,
  className,
}: SessionHeaderProps) {
  // Find the SDK's display name for the current model so the dropdown
  // trigger shows a human-friendly label (Sonnet 4.6) instead of the raw
  // value (claude-sonnet-4-6). Fall back to the raw model string.
  const currentModelLabel =
    (supportedModels && model &&
      supportedModels.find((m) => m.value === model)?.displayName) ||
    model ||
    "Model";

  const currentPermissionLabel =
    PERMISSION_MODE_OPTIONS.find((o) => o.value === permissionMode)?.label ??
    "Permissions";
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
        {/* Wave 2.5 — live model picker. Only rendered when the parent
            hands us a supportedModels list from query.supportedModels()
            AND a change callback; otherwise the header stays read-only
            (shows the model as plain text via the context widget's
            internal usage). */}
        {supportedModels && supportedModels.length > 0 && onModelChange && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 px-2 py-0.5 rounded-md hover:bg-foreground/10 transition-colors text-foreground/70"
                title="Switch model (live — from query.supportedModels())"
              >
                <Cpu className="w-3 h-3 text-foreground/40" />
                <span className="font-mono text-xs truncate max-w-[140px]">
                  {currentModelLabel}
                </span>
                <ChevronDown className="w-3 h-3 text-foreground/40" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Switch model
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {supportedModels.map((m) => {
                const isActive = m.value === model;
                return (
                  <DropdownMenuItem
                    key={m.value}
                    onClick={() => onModelChange(m.value)}
                    className="flex items-start gap-2"
                  >
                    <Check
                      className={cn(
                        "w-3 h-3 mt-1 shrink-0",
                        isActive ? "text-primary" : "text-transparent",
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">
                        {m.displayName}
                      </div>
                      <div className="text-[10px] text-muted-foreground line-clamp-2">
                        {m.description}
                      </div>
                    </div>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Wave 2.4b — mid-session permission mode picker. Same gating:
            only rendered when the parent wires a change callback. */}
        {onPermissionModeChange && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 px-2 py-0.5 rounded-md hover:bg-foreground/10 transition-colors text-foreground/70"
                title="Change permission mode (applies to the running session immediately)"
              >
                <Lock className="w-3 h-3 text-foreground/40" />
                <span className="text-xs truncate max-w-[120px]">
                  {currentPermissionLabel}
                </span>
                <ChevronDown className="w-3 h-3 text-foreground/40" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Permission mode
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {PERMISSION_MODE_OPTIONS.map((opt) => {
                const isActive = opt.value === permissionMode;
                return (
                  <DropdownMenuItem
                    key={opt.value}
                    onClick={() => onPermissionModeChange(opt.value)}
                    className="flex items-start gap-2"
                  >
                    <Check
                      className={cn(
                        "w-3 h-3 mt-1 shrink-0",
                        isActive ? "text-primary" : "text-transparent",
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium">{opt.label}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {opt.description}
                      </div>
                    </div>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

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
              <HoverCardContent align="end" className="w-96">
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
