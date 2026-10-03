import * as React from "react";
import { User, Clock, CalendarDays, DollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RateLimitSnapshot } from "@/lib/api";
import { useAccounts } from "@/contexts/AccountsContext";
import { useTheme } from "@/hooks";
import { Popover } from "@/components/ui/popover";
import { ICON_MAP } from "./IconPicker";
import { accountShield, buildThemedColors, fallbackTextColor } from "./AccountBadge";
import { useAccountDetailsPopover, type AccountDetailsInputs } from "./AccountDetails";
import { rateLimitPctAlert, rateLimitPctColor } from "./claude-code-session/RateLimitWidget";
import { formatCost } from "./claude-code-session/CostWidget";
import { UsageDetailPopover } from "./claude-code-session/UsageDetailPopover";
import type { AccountUsage } from "@/hooks/useAccountUsage";

/**
 * The account widget as a status-bar readout:
 * `[icon] account Personal: max [shield] | [clock] 42% [calendar] 18%`.
 *
 * Two buttons, two popovers, as the widget has: the name opens the account
 * details (`useAccountDetailsPopover`, the widget's own body) and the usage
 * opens `UsageDetailPopover`. Lives alongside the widget for now, so the two
 * can be compared before one of them goes.
 *
 * The icon, label and name wear the account's colour, as the badge does —
 * text only, not its chip, at the bar's weight.
 */

export interface AccountStatusItemProps extends AccountDetailsInputs {
  /** Cost-based accounts show dollars; the rest show the 5-hour and weekly
   *  windows. */
  hasCost?: boolean;
  /** `/usage` and computed cost, owned by AgentSession — see useAccountUsage. */
  usage: AccountUsage;
  fiveHourRateLimit?: RateLimitSnapshot | null;
  sevenDayRateLimit?: RateLimitSnapshot | null;
}

export function AccountStatusItem({
  hasCost,
  usage,
  fiveHourRateLimit = null,
  sevenDayRateLimit = null,
  ...detailInputs
}: AccountStatusItemProps): React.JSX.Element {
  const { accountName, verification, sessionAuthFailure = null } = detailInputs;
  const { getColor, getIcon, getAccountType } = useAccounts();
  const { theme } = useTheme();
  const details = useAccountDetailsPopover(detailInputs);
  const [usageOpen, setUsageOpen] = React.useState(false);

  const color = getColor(accountName);
  const type = getAccountType(accountName);
  const icon = getIcon(accountName);
  const Icon = (icon && ICON_MAP[icon]) || User;
  const shield = accountShield(verification?.status, sessionAuthFailure !== null);

  return (
    <span className="flex items-center gap-1.5">
      <Popover
        open={details.open}
        onOpenChange={details.onOpenChange}
        align="end"
        side="bottom"
        className="w-96"
        trigger={
          <button
            type="button"
            aria-label={`account ${accountName}${shield ? `, ${shield.label}` : ""}`}
            title="Click for account details"
            className={cn(
              "flex items-center gap-1 rounded hover:bg-muted/60",
              !color && fallbackTextColor(accountName),
            )}
            style={color ? { color: buildThemedColors(color, theme).color } : undefined}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="opacity-70">account</span>
            <span data-testid="account-item-name">
              {accountName}
              {type && `: ${type}`}
            </span>
            {shield && (
              <shield.Icon
                role="img"
                aria-label={shield.label}
                className={cn("h-3.5 w-3.5", shield.className)}
                strokeWidth={2.4}
              />
            )}
          </button>
        }
        content={details.content}
      />
      {details.signInModal}
      <UsageDetailPopover
        open={usageOpen}
        onOpenChange={setUsageOpen}
        data={usage.data}
        loading={usage.loading}
        onRefresh={() => void usage.refresh()}
        sessionCost={hasCost ? usage.sessionCost : null}
        trigger={
          hasCost ? (
            <CostReadout cost={usage.sessionCost} loading={usage.loading} />
          ) : (
            <RateLimitReadout fiveHour={fiveHourRateLimit} sevenDay={sevenDayRateLimit} />
          )
        }
      />
    </span>
  );
}

const USAGE_BUTTON = "flex items-center gap-1 rounded hover:bg-muted/60";

function pctOf(snapshot: RateLimitSnapshot | null): number | null {
  return snapshot?.utilization == null ? null : Math.max(0, Math.min(100, snapshot.utilization));
}

/** One window's icon and percentage, coloured by its own severity. */
function WindowPct({
  snapshot,
  Icon,
  testId,
}: {
  snapshot: RateLimitSnapshot | null;
  Icon: typeof Clock;
  testId: string;
}): React.JSX.Element {
  const pct = pctOf(snapshot);
  const rejected = snapshot?.status === "rejected";
  return (
    <span className="flex items-center gap-1">
      <Icon className={cn("h-3 w-3", rejected && "text-red-400")} />
      <span
        data-testid={testId}
        className={cn(rateLimitPctColor(pct, rejected), rateLimitPctAlert(pct, rejected) && "animate-pulse")}
      >
        {pct == null ? "—" : `${pct.toFixed(0)}%`}
      </span>
    </span>
  );
}

/** The 5-hour and weekly windows — `/usage`'s current session and current
 *  week. One button: both open the same popover. */
function RateLimitReadout({
  fiveHour,
  sevenDay,
}: {
  fiveHour: RateLimitSnapshot | null;
  sevenDay: RateLimitSnapshot | null;
}): React.JSX.Element {
  const describe = (label: string, s: RateLimitSnapshot | null): string => {
    const pct = pctOf(s);
    return `${label}: ${pct == null ? "no data yet" : `${pct.toFixed(1)}%`}`;
  };
  return (
    <button
      type="button"
      aria-label="usage, current session and week"
      title={`${describe("Current session (5h)", fiveHour)}\n${describe("Current week (7d)", sevenDay)}`}
      // Wider than the icon-to-value gap, so each pair reads as one window.
      className={cn(USAGE_BUTTON, "gap-2")}
    >
      <WindowPct snapshot={fiveHour} Icon={Clock} testId="account-item-usage" />
      <WindowPct snapshot={sevenDay} Icon={CalendarDays} testId="account-item-usage-week" />
    </button>
  );
}

/** Dollars this session has cost so far, for accounts billed per token. */
function CostReadout({
  cost,
  loading,
}: {
  cost: AccountUsage["sessionCost"];
  loading: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label="usage, session cost"
      title={cost ? `Session cost: ${cost.estimated ? "~" : ""}${formatCost(cost.totalUsd)}` : "No session cost yet"}
      className={cn(USAGE_BUTTON, loading && "opacity-60")}
    >
      <DollarSign className="h-3.5 w-3.5" />
      {/* The icon carries the $, as on the cost widget. */}
      <span data-testid="account-item-usage">
        {cost ? `${cost.estimated ? "~" : ""}${formatCost(cost.totalUsd).slice(1)}` : "—"}
      </span>
    </button>
  );
}
