import React from "react";
import { cn } from "@/lib/utils";
import { useAccounts } from "@/contexts/AccountsContext";
import { useTheme } from "@/hooks";
import { ICON_MAP } from "./IconPicker";
import { User, ShieldCheck, ShieldAlert, ShieldQuestion } from "lucide-react";
import { BrandIcon } from "./shared/BrandIcon";
import type { AgentKind, IdentityStatus } from "@/lib/api";

const FALLBACK_COLORS = [
  "bg-blue-500/20 text-blue-400 border-blue-500/30 dark:text-blue-400",
  "bg-purple-500/20 text-purple-400 border-purple-500/30",
  "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  "bg-amber-500/20 text-amber-400 border-amber-500/30",
  "bg-rose-500/20 text-rose-400 border-rose-500/30",
  "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
];

function getFallbackColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

export function fallbackTextColor(name: string): string {
  return getFallbackColor(name).split(" ").find((c) => c.startsWith("text-")) ?? "";
}

export interface AccountShield {
  Icon: typeof ShieldCheck;
  className: string;
  label: string;
}

/**
 * A lost session sign-in outranks the verdict: the process never re-reads its
 * credentials. Colors are hard-coded, not themed: red mixed toward an amber
 * tint stops reading as an alert.
 */
export function accountShield(
  verification: IdentityStatus | null | undefined,
  sessionSignedOut: boolean,
): AccountShield | null {
  if (sessionSignedOut) {
    return {
      Icon: ShieldAlert,
      className: "text-red-500",
      label: "This session's sign-in expired — sign in again to continue",
    };
  }
  if (!verification) return null;
  return {
    verified: {
      Icon: ShieldCheck,
      className: "text-emerald-500",
      label: "Signed in as the expected account",
    },
    mismatch: {
      Icon: ShieldAlert,
      className: "text-red-500",
      label: "Signed in as a DIFFERENT account than expected",
    },
    "signed-out": {
      Icon: ShieldAlert,
      className: "text-red-500",
      label: "This config directory is not signed in",
    },
    "unknown-account": {
      Icon: ShieldQuestion,
      className: "opacity-70",
      label: "Couldn't verify — no account owns this config directory",
    },
    unverified: null,
  }[verification];
}

export function buildThemedColors(color: string, theme: "gray" | "light"): {
  backgroundColor: string;
  color: string;
  borderColor: string;
} {
  if (theme === "light") {
    return {
      backgroundColor: `color-mix(in oklch, ${color} 18%, white)`,
      color: `color-mix(in oklch, ${color} 70%, black)`,
      borderColor: `color-mix(in oklch, ${color} 55%, white)`,
    };
  }
  return {
    backgroundColor: `color-mix(in oklch, ${color} 20%, transparent)`,
    color,
    borderColor: `color-mix(in oklch, ${color} 30%, transparent)`,
  };
}

interface AccountBadgeProps {
  name: string;
  color?: string | null;
  icon?: string | null;
  accountType?: string | null;
  agent?: AgentKind | null;
  verification?: IdentityStatus | null;
  sessionSignedOut?: boolean;
  variant?: "full" | "compact";
  size?: "xs" | "sm";
  /** Keeps the trailing mark: a mismatch shield must show in narrow windows too. */
  hideName?: boolean;
  className?: string;
}

export const AccountBadge: React.FC<AccountBadgeProps> = ({
  name,
  color: colorProp,
  icon,
  accountType: accountTypeProp,
  agent,
  verification,
  sessionSignedOut = false,
  variant = "full",
  size = "xs",
  hideName = false,
  className,
}) => {
  const { getColor, getIcon, getAccountType } = useAccounts();
  const { theme } = useTheme();
  const color = colorProp ?? getColor(name);
  const resolvedIcon = icon ?? getIcon(name);
  const resolvedType = accountTypeProp ?? getAccountType(name);
  const IconComponent = (resolvedIcon && ICON_MAP[resolvedIcon]) || User;
  const textSizeClass = size === "sm" ? "text-xs" : "text-[11px]";
  const iconSizeClass = size === "sm" ? "h-[15px] w-[15px]" : "h-[14px] w-[14px]";
  const fallbackIconSizeClass = size === "sm" ? "h-[12px] w-[12px]" : "h-[11px] w-[11px]";
  const brandIconSizeClass = size === "sm" ? "h-[13px] w-[13px]" : "h-[12px] w-[12px]";
  const brandIconColorClass = theme === "light" ? "text-neutral-900" : "text-white";

  const shield = accountShield(verification, sessionSignedOut);

  const trailingMark = shield ? (
    <shield.Icon
      role="img"
      aria-label={shield.label}
      className={cn(brandIconSizeClass, shield.className)}
      strokeWidth={2.4}
    />
  ) : agent ? (
    <BrandIcon
      agent={agent}
      className={cn(brandIconSizeClass, brandIconColorClass, "opacity-90")}
    />
  ) : null;

  if (variant === "compact") {
    if (color) {
      // Inset shadow as the border keeps the chip a fixed 18px square.
      const compactColors = buildThemedColors(color, theme);
      return (
        <span
          title={name}
          className={cn(
            "inline-flex items-center justify-center rounded h-[18px] w-[18px] flex-shrink-0",
            className,
          )}
          style={{
            backgroundColor: compactColors.backgroundColor,
            color: compactColors.color,
            boxShadow: `inset 0 0 0 1px ${compactColors.borderColor}`,
          }}
        >
          <IconComponent className="h-[13px] w-[13px]" strokeWidth={2.2} />
        </span>
      );
    }
    return (
      <span
        title={name}
        className={cn(
          "inline-flex items-center justify-center rounded h-[18px] w-[18px] flex-shrink-0",
          getFallbackColor(name),
          className,
        )}
      >
        <IconComponent className="h-[13px] w-[13px]" strokeWidth={2.2} />
      </span>
    );
  }

  if (color) {
    return (
      <span
        title={hideName ? name : undefined}
        className={cn(
          "inline-flex items-center gap-1 rounded border px-2 py-0.5 font-medium whitespace-nowrap",
          textSizeClass,
          className,
        )}
        style={buildThemedColors(color, theme)}
      >
        <IconComponent className={iconSizeClass} strokeWidth={2.2} />
        {!hideName && name}
        {!hideName && resolvedType && (
          <span className="opacity-70">: {resolvedType}</span>
        )}
        {trailingMark}
      </span>
    );
  }

  const fallbackClass = getFallbackColor(name);
  return (
    <span
      title={hideName ? name : undefined}
      className={cn(
        "inline-flex items-center gap-1 rounded border px-2 py-0.5 font-medium whitespace-nowrap",
        textSizeClass,
        fallbackClass,
        className,
      )}
    >
      <IconComponent className={fallbackIconSizeClass} strokeWidth={2.2} />
      {!hideName && name}
      {trailingMark}
    </span>
  );
};
