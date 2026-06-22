import * as React from "react";
import { ShieldCheck, ShieldAlert, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  AgentKind,
  SessionAccountInfo,
  RateLimitSnapshot,
} from "@/lib/api";
import { Popover } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { AccountBadge } from "./AccountBadge";
import { HeaderLabel } from "./HeaderLabel";
import { RateLimitWidget } from "./claude-code-session/RateLimitWidget";
import { CostWidget } from "./claude-code-session/CostWidget";
import { UsageDetailPopover } from "./claude-code-session/UsageDetailPopover";
import { useUsageAutoRefresh } from "@/hooks/useUsageAutoRefresh";

interface AccountCardProps {
  accountName: string;
  /** Whether usage on this account costs money (true for e.g. Enterprise/API,
   *  false for Max). Drives the usage widget: cost-based accounts show a dollar
   *  figure (they have no rate-limit windows); rate-limited accounts show the
   *  5h/7d utilization chart. */
  hasCost?: boolean;
  /** Engine driving this session. When set, the account badge appends the
   *  brand mark after the account type (e.g. "Personal : max [Claude]"). */
  agent?: AgentKind | null;
  configDir: string;
  matchType: string;
  matchDetail: string;
  sdkAccount?: SessionAccountInfo | null;
  fiveHourRateLimit?: RateLimitSnapshot | null;
  sevenDayRateLimit?: RateLimitSnapshot | null;
  /** Drives the visibility-aware /usage auto-refresh inside the card. */
  sessionStatus?: 'starting' | 'active' | 'ended';
  className?: string;
}

/**
 * Compact account-and-usage card. Pulled out of SessionHeader so it can be
 * mounted inline in the upper toolbar (next to folder/branch) without
 * dragging the rest of the session header along.
 */
export function AccountCard({
  accountName,
  hasCost,
  agent,
  configDir,
  matchType,
  matchDetail,
  sdkAccount,
  fiveHourRateLimit,
  sevenDayRateLimit,
  sessionStatus,
  className,
}: AccountCardProps) {
  const [accountPopoverOpen, setAccountPopoverOpen] = React.useState(false);
  const [usagePopoverOpen, setUsagePopoverOpen] = React.useState(false);

  // Cost-based accounts (Enterprise/API) are billed per token and expose no
  // rate-limit windows, so we show a dollar figure instead of the 5h/7d chart.
  // Both variants still fetch /usage and open the same detail popover.
  const costBased = hasCost === true;

  const {
    data: usageData,
    loading: usageLoading,
    refresh: refreshUsage,
  } = useUsageAutoRefresh(accountName, sessionStatus === 'active');

  const sessionCostUsd =
    usageData?.ok ? usageData.parsed.session.cost_usd : null;

  const handleRefreshClick = React.useCallback(async () => {
    if (usageLoading) return;
    await refreshUsage();
  }, [refreshUsage, usageLoading]);

  const sdkMismatch =
    sdkAccount?.apiProvider !== undefined &&
    sdkAccount.apiProvider !== 'firstParty';

  const matchLabel = matchType === "path_rule"
    ? "path rule"
    : matchType === "project_override"
    ? "project override"
    : "default";

  return (
    <div className={cn("flex items-start gap-3 rounded-md border-0 bg-background/40 px-2 py-1 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent),2px_2px_4px_rgb(0_0_0/0.08)]", className)}>
      <div className="flex flex-col items-start gap-0.5">
        <HeaderLabel>account</HeaderLabel>
        <Popover
          open={accountPopoverOpen}
          onOpenChange={setAccountPopoverOpen}
          align="start"
          side="bottom"
          className="w-96"
          trigger={
            <button
              type="button"
              className="rounded hover:opacity-80 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Click for account details"
            >
              <AccountBadge name={accountName} agent={agent} />
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
                    CLI-reported account
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
      </div>
      <UsageDetailPopover
        open={usagePopoverOpen}
        onOpenChange={setUsagePopoverOpen}
        data={usageData}
        loading={usageLoading}
        onRefresh={() => void refreshUsage()}
        align="start"
        trigger={
          costBased ? (
            // Invisible label spacer so the single cost pill drops down to the
            // account-badge row instead of sitting up at the "account" label
            // (the parent row is items-start). Mirrors the account column's
            // label + badge stack without hardcoding the label height.
            <div className="flex flex-col items-start gap-0.5">
              <HeaderLabel aria-hidden className="invisible">account</HeaderLabel>
              <CostWidget
                costUsd={sessionCostUsd}
                loading={usageLoading}
                accountName={accountName}
                onClick={() => { setUsagePopoverOpen((v) => !v); }}
                hideLabel
              />
            </div>
          ) : (
            <div className="flex flex-col items-start gap-1">
              <RateLimitWidget
                snapshot={fiveHourRateLimit ?? null}
                windowType="five_hour"
                accountName={accountName}
                onClick={() => { setUsagePopoverOpen((v) => !v); }}
                hideLabel
              />
              <RateLimitWidget
                snapshot={sevenDayRateLimit ?? null}
                windowType="seven_day"
                accountName={accountName}
                onClick={() => { setUsagePopoverOpen((v) => !v); }}
                hideLabel
              />
            </div>
          )
        }
      />
      {(() => {
        const refreshButton = (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleRefreshClick()}
            disabled={usageLoading}
            className="h-5 w-5 p-0 rounded-sm border-0 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]"
            title={
              usageLoading
                ? 'Refreshing /usage…'
                : 'Pull fresh account stats'
            }
          >
            <RefreshCw className={cn('h-3.5 w-3.5', usageLoading && 'animate-spin')} />
          </Button>
        );
        // Cost view is a single pill on the badge row, so drop the refresh
        // button to that row too (same invisible-label spacer as the pill).
        // The chart view stacks two pills, so the button stays at the top.
        return costBased ? (
          <div className="flex flex-col items-start gap-0.5">
            <HeaderLabel aria-hidden className="invisible">account</HeaderLabel>
            {refreshButton}
          </div>
        ) : (
          refreshButton
        );
      })()}
    </div>
  );
}
