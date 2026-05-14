import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api, type AccountUsageStats, type UsageStats } from "@/lib/api";
import { AccountBadge } from "@/components/AccountBadge";
import { useAccounts } from "@/contexts/AccountsContext";
import { Filter, ChevronDown, ChevronUp } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

interface UsageDashboardProps {
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const fmtCurrency = (amount: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);

const fmtTokens = (num: number): string => {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US").format(num);
};

const fmtNumber = (num: number): string =>
  new Intl.NumberFormat("en-US").format(num);

const modelDisplayName = (model: string): string => {
  if (model.includes("opus") && model.includes("4")) return "Opus 4";
  if (model.includes("sonnet") && model.includes("4")) return "Sonnet 4";
  if (model.includes("sonnet") && model.includes("3.5")) return "Sonnet 3.5";
  if (model.includes("haiku")) return "Haiku";
  return model;
};

// ---------------------------------------------------------------------------
// Account Section
// ---------------------------------------------------------------------------

const AccountSection: React.FC<{
  accountName: string;
  accountType: string;
  stats: UsageStats;
}> = ({ accountName, accountType, stats }) => {
  const [showProjects, setShowProjects] = useState(false);

  const sortedModels = useMemo(
    () => [...stats.by_model].sort((a, b) => b.total_cost - a.total_cost),
    [stats.by_model],
  );

  const sortedProjects = useMemo(
    () => [...stats.by_project].sort((a, b) => b.total_cost - a.total_cost),
    [stats.by_project],
  );

  const isMax = accountType === "max";

  return (
    <div className="space-y-4">
      {/* Account header */}
      <div className="flex items-center gap-3">
        <AccountBadge name={accountName} />
        <span className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {accountType}
        </span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Cost</p>
          <p className="text-lg font-semibold mt-1">
            {isMax ? "Included" : fmtCurrency(stats.total_cost)}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Sessions</p>
          <p className="text-lg font-semibold mt-1">
            {fmtNumber(stats.total_sessions)}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Tokens</p>
          <p className="text-lg font-semibold mt-1">
            {fmtTokens(stats.total_tokens)}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Avg / Session</p>
          <p className="text-lg font-semibold mt-1">
            {isMax
              ? "\u2014"
              : fmtCurrency(
                  stats.total_sessions > 0
                    ? stats.total_cost / stats.total_sessions
                    : 0,
                )}
          </p>
        </Card>
      </div>

      {/* Models breakdown */}
      {sortedModels.length > 0 && (
        <Card className="p-4">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
            By Model
          </h4>
          <div className="space-y-2">
            {sortedModels.map((m) => (
              <div
                key={m.model}
                className="flex items-center justify-between text-sm"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    {modelDisplayName(m.model)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {fmtTokens(m.input_tokens + m.output_tokens)} tokens
                  </span>
                </div>
                <span className="font-medium">
                  {isMax ? "\u2014" : fmtCurrency(m.total_cost)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Projects — collapsed by default */}
      {sortedProjects.length > 0 && (
        <Card className="p-4">
          <button
            type="button"
            className="w-full flex items-center justify-between"
            onClick={() => { setShowProjects((p) => !p); }}
          >
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Projects ({sortedProjects.length})
            </h4>
            {showProjects ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          {showProjects && (
            <div className="mt-3 space-y-2">
              {sortedProjects.map((p) => (
                <div
                  key={p.project_path}
                  className="flex items-center justify-between text-sm border-b border-border/30 pb-2 last:border-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p
                      className="font-medium truncate max-w-[300px]"
                      title={p.project_path}
                    >
                      {p.project_path.replace(/^\/Users\/[^/]+/, "~")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {p.session_count} sessions &middot;{" "}
                      {fmtTokens(p.total_tokens)} tokens
                    </p>
                  </div>
                  <span className="font-medium shrink-0 ml-4">
                    {isMax ? "\u2014" : fmtCurrency(p.total_cost)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export const UsageDashboard: React.FC<UsageDashboardProps> = ({}) => {
  const { accounts } = useAccounts();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accountStats, setAccountStats] = useState<AccountUsageStats[]>([]);
  const [selectedDateRange, setSelectedDateRange] = useState<
    "all" | "7d" | "30d"
  >("30d");
  const [selectedAccount, setSelectedAccount] = useState<string>("all");

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      let startDate: string | undefined;
      let endDate: string | undefined;

      if (selectedDateRange !== "all") {
        const end = new Date();
        const start = new Date();
        start.setDate(
          start.getDate() - (selectedDateRange === "7d" ? 7 : 30),
        );
        startDate = start.toISOString().slice(0, 10);
        endDate = end.toISOString().slice(0, 10);
      }

      const data = await api.getUsageByAccount(startDate, endDate);
      setAccountStats(data);
    } catch (err) {
      console.error("Failed to load usage stats:", err);
      setError("Failed to load usage statistics.");
    } finally {
      setLoading(false);
    }
  }, [selectedDateRange]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Filter stats by selected account
  const visibleStats = useMemo(() => {
    if (selectedAccount === "all") return accountStats;
    return accountStats.filter((a) => a.account_name === selectedAccount);
  }, [accountStats, selectedAccount]);

  // Compute grand totals across visible accounts
  const grandTotals = useMemo(() => {
    let cost = 0;
    let sessions = 0;
    let tokens = 0;
    for (const a of visibleStats) {
      cost += a.stats.total_cost;
      sessions += a.stats.total_sessions;
      tokens += a.stats.total_tokens;
    }
    return { cost, sessions, tokens };
  }, [visibleStats]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto flex flex-col h-full">
        {/* Header */}
        <div className="p-6 shrink-0 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold">Usage Dashboard</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {fmtNumber(grandTotals.sessions)} sessions &middot;{" "}
                {fmtTokens(grandTotals.tokens)} tokens
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              {(["7d", "30d", "all"] as const).map((range) => (
                <Button
                  key={range}
                  variant={selectedDateRange === range ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setSelectedDateRange(range); }}
                  disabled={loading}
                >
                  {range === "all"
                    ? "All Time"
                    : range === "7d"
                      ? "7 Days"
                      : "30 Days"}
                </Button>
              ))}
            </div>
          </div>

          {/* Account picker */}
          {accounts.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Account:</span>
              <button
                type="button"
                className={cn(
                  "text-xs px-2.5 py-1 rounded-md transition-colors",
                  selectedAccount === "all"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
                onClick={() => { setSelectedAccount("all"); }}
              >
                All
              </button>
              {accounts.map((acct) => (
                <button
                  key={acct.id}
                  type="button"
                  className={cn(
                    "text-xs px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5",
                    selectedAccount === acct.name
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                  onClick={() => { setSelectedAccount(acct.name); }}
                >
                  {acct.name}
                  <span className="opacity-60 uppercase text-[10px]">
                    {acct.account_type}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Spinner className="size-8 text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/50 text-sm text-destructive">
              {error}
              <Button onClick={loadData} size="sm" className="ml-4">
                Try Again
              </Button>
            </div>
          ) : visibleStats.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">
              No usage data found for the selected period.
            </div>
          ) : (
            <div className="space-y-8">
              {visibleStats.map((a) => (
                <AccountSection
                  key={a.account_name}
                  accountName={a.account_name}
                  accountType={a.account_type}
                  stats={a.stats}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
