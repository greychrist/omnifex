import React from "react";
import { cn } from "@/lib/utils";

const ACCOUNT_COLORS: Record<string, string> = {
  personal: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  work: "bg-purple-500/20 text-purple-400 border-purple-500/30",
};

const FALLBACK_COLORS = [
  "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  "bg-amber-500/20 text-amber-400 border-amber-500/30",
  "bg-rose-500/20 text-rose-400 border-rose-500/30",
  "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
];

function getColorForAccount(name: string): string {
  if (ACCOUNT_COLORS[name]) return ACCOUNT_COLORS[name];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

interface AccountBadgeProps {
  name: string;
  className?: string;
}

export const AccountBadge: React.FC<AccountBadgeProps> = ({ name, className }) => {
  const colorClass = getColorForAccount(name);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        colorClass,
        className
      )}
    >
      {name}
    </span>
  );
};
