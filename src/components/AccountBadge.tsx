import React from "react";
import { cn } from "@/lib/utils";
import { useAccounts } from "@/contexts/AccountsContext";
import { ICON_MAP } from "./IconPicker";
import { User } from "lucide-react";

const FALLBACK_COLORS = [
  "bg-blue-500/20 text-blue-400 border-blue-500/30",
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

interface AccountBadgeProps {
  name: string;
  color?: string | null;
  icon?: string | null;
  accountType?: string | null;
  variant?: "full" | "compact";
  className?: string;
}

export const AccountBadge: React.FC<AccountBadgeProps> = ({
  name,
  color: colorProp,
  icon,
  accountType: accountTypeProp,
  variant = "full",
  className,
}) => {
  const { getColor, getIcon, getAccountType } = useAccounts();
  const color = colorProp ?? getColor(name);
  const resolvedIcon = icon ?? getIcon(name);
  const resolvedType = accountTypeProp ?? getAccountType(name);
  const IconComponent = (resolvedIcon && ICON_MAP[resolvedIcon]) || User;

  if (variant === "compact") {
    if (color) {
      return (
        <span
          title={name}
          className={cn(
            "inline-flex items-center justify-center rounded h-[18px] w-[18px] flex-shrink-0",
            className,
          )}
          style={{
            backgroundColor: `${color}2e`,
            color: color,
            boxShadow: `inset 0 0 0 1px ${color}4d`,
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
        className={cn(
          "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
          className,
        )}
        style={{
          backgroundColor: `${color}33`,
          color: color,
          borderColor: `${color}4d`,
        }}
      >
        <IconComponent className="h-[11px] w-[11px]" strokeWidth={2.2} />
        {name}
        {resolvedType && (
          <span className="opacity-70">: {resolvedType}</span>
        )}
      </span>
    );
  }

  const fallbackClass = getFallbackColor(name);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        fallbackClass,
        className,
      )}
    >
      <IconComponent className="h-[11px] w-[11px]" strokeWidth={2.2} />
      {name}
    </span>
  );
};
