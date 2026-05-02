import * as React from "react";
import { ShieldCheck, ShieldAlert, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  SessionAccountInfo,
  RateLimitSnapshot,
} from "@/lib/api";
import { Popover } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { AccountBadge } from "./AccountBadge";
import { HeaderLabel } from "./HeaderLabel";
import { RateLimitWidget } from "./claude-code-session/RateLimitWidget";
import { UsageDetailPopover } from "./claude-code-session/UsageDetailPopover";
import { useUsageAutoRefresh } from "@/hooks/useUsageAutoRefresh";

interface AccountCardProps {
  accountName: string;
  /** Account type: "max", "enterprise", "pro", "free". Enterprise accounts
   *  hide the rate-limit widgets + refresh button since those numbers have
   *  no meaning under an enterprise plan. */
  accountType?: string;
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
  accountType,
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

  const showUsage = accountType !== "enterprise";

  const {
    data: usageData,
    loading: usageLoading,
    refresh: refreshUsage,
  } = useUsageAutoRefresh(accountName, showUsage && sessionStatus === 'active');

  const handleRefreshClick = React.useCallback(async () => {
    if (usageLoading) return;
    await refreshUsage();
  }, [refreshUsage, usageLoading]);

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
              <AccountBadge name={accountName} />
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
      </div>
      {showUsage && (
        <>
          <UsageDetailPopover
            open={usagePopoverOpen}
            onOpenChange={setUsagePopoverOpen}
            data={usageData}
            loading={usageLoading}
            onRefresh={() => void refreshUsage()}
            align="start"
            trigger={
              <div className="flex flex-col items-start gap-1">
                <RateLimitWidget
                  snapshot={fiveHourRateLimit ?? null}
                  windowType="five_hour"
                  accountName={accountName}
                  onClick={() => setUsagePopoverOpen((v) => !v)}
                  hideLabel
                />
                <RateLimitWidget
                  snapshot={sevenDayRateLimit ?? null}
                  windowType="seven_day"
                  accountName={accountName}
                  onClick={() => setUsagePopoverOpen((v) => !v)}
                  hideLabel
                />
              </div>
            }
          />
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
        </>
      )}
    </div>
  );
}
