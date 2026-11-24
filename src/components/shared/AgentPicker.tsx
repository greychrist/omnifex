import React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AgentKind } from "@/lib/api";

export interface AgentPickerProps {
  value: AgentKind;
  onChange: (agent: AgentKind) => void;
  disabled?: boolean;
  className?: string;
}

export const AgentPicker: React.FC<AgentPickerProps> = ({
  value,
  onChange,
  disabled = false,
  className,
}) => {
  const options: { id: AgentKind; label: string }[] = [
    { id: "claude", label: "Claude" },
    { id: "codex", label: "Codex" },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Agent"
      className={cn("inline-flex items-center gap-1", className)}
    >
      {options.map((opt) => {
        const selected = opt.id === value;
        return (
          <Button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={selected}
            variant={selected ? "default" : "outline"}
            size="sm"
            disabled={disabled}
            onClick={() => {
              if (!selected) onChange(opt.id);
            }}
            className="h-9 px-3 font-normal text-[11px]"
          >
            {opt.label}
          </Button>
        );
      })}
    </div>
  );
};
