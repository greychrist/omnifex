import * as React from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RateLimitSnapshot, IdentityStatus } from "@/lib/api";
import { Popover } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { AccountBadge } from "./AccountBadge";
import { useAccountDetailsPopover, type AccountDetailsInputs } from "./AccountDetails";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { HeaderLabel } from "./HeaderLabel";
import { RateLimitWidget } from "./claude-code-session/RateLimitWidget";
import { CostWidget } from "./claude-code-session/CostWidget";
import { UsageDetailPopover } from "./claude-code-session/UsageDetailPopover";
import type { AccountUsage } from "@/hooks/useAccountUsage";

interface AccountCardProps extends AccountDetailsInputs {
  /** Whether usage on this account costs money (true for e.g. Enterprise/API,
   *  false for Max). Drives the usage widget: cost-based accounts show a dollar
   *  figure (they have no rate-limit windows); rate-limited accounts show the
   *  5h/7d utilization chart. */
  hasCost?: boolean;
  /** `/usage` and computed cost, owned by AgentSession — see useAccountUsage. */
  usage: AccountUsage;
  fiveHourRateLimit?: RateLimitSnapshot | null;
  sevenDayRateLimit?: RateLimitSnapshot | null;
  className?: string;
}

/**
 * Compact account-and-usage card. Pulled out of SessionHeader so it can be
 * mounted inline in the upper toolbar (next to folder/branch) without
 * dragging the rest of the session header along.
 */
export function AccountCard({
  hasCost,
  usage,
  fiveHourRateLimit,
  sevenDayRateLimit,
  className,
  ...detailInputs
}: AccountCardProps) {
  const { accountName, agent, verification, sessionAuthFailure = null, onRecheck } = detailInputs;
  const { narrow } = useLayoutMode();
  const details = useAccountDetailsPopover(detailInputs);
  const [usagePopoverOpen, setUsagePopoverOpen] = React.useState(false);

  const shieldStatus: IdentityStatus | null = verification?.status ?? null;

  // Cost-based accounts (Enterprise/API) are billed per token and expose no
  // rate-limit windows, so we show a dollar figure instead of the 5h/7d chart.
  // Both variants still fetch /usage and open the same detail popover.
  const costBased = hasCost === true;

  const { data: usageData, loading: usageLoading, refresh: refreshUsage } = usage;
  const computedCost = usage.sessionCost;
  const sessionCostUsd = computedCost?.totalUsd ?? null;

  // Also re-runs the identity check: the verdict is otherwise re-read only on
  // an on-disk login change, so an expected email edited in Settings would
  // stay stale in an open session until this.
  const handleRefreshClick = React.useCallback(async () => {
    onRecheck?.();
    if (usageLoading) return;
    await refreshUsage();
  }, [onRecheck, refreshUsage, usageLoading]);

  return (
    <div className={cn("flex items-start gap-3 rounded-md border-0 bg-background/40 px-2 py-1 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent),2px_2px_4px_rgb(0_0_0/0.08)]", className)}>
      <div className="flex flex-col items-start gap-0.5">
        <HeaderLabel>account</HeaderLabel>
        <Popover
          open={details.open}
          onOpenChange={details.onOpenChange}
          align="start"
          side="bottom"
          className="w-96"
          trigger={
            <button
              type="button"
              className="rounded hover:opacity-80 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Click for account details"
            >
              <AccountBadge
                name={accountName}
                agent={agent}
                verification={shieldStatus}
                sessionSignedOut={sessionAuthFailure !== null}
                hideName={narrow}
              />
            </button>
          }
          content={details.content}
        />
      </div>
      {details.signInModal}
      <UsageDetailPopover
        open={usagePopoverOpen}
        onOpenChange={setUsagePopoverOpen}
        data={usageData}
        loading={usageLoading}
        onRefresh={() => void refreshUsage()}
        align="start"
        sessionCost={costBased ? computedCost : null}
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
                estimated={computedCost?.estimated ?? false}
                breakdown={computedCost}
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
            className="h-5 w-5 p-0 rounded-sm border-0 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]"
            title={
              usageLoading
                ? 'Refreshing /usage…'
                : 'Refresh account identity and usage'
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
