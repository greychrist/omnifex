import React from "react";
import { Bot } from "lucide-react";

export const AgentCountGlyph: React.FC<{ count: number }> = ({ count }) => {
  const label = `${count} background agent${count === 1 ? '' : 's'} working`;
  return (
    <span className="inline-flex items-center gap-0.5 text-sky-400" aria-label={label} title={label}>
      <Bot className="size-3.5 animate-pulse" />
      {count > 1 && (
        <span className="text-[10px] font-medium tabular-nums leading-none">{count}</span>
      )}
    </span>
  );
};
