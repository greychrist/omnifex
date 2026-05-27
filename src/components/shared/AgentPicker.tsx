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

/**
 * Two-option toggle for picking the engine that drives a new session.
 * "Claude" runs the Claude CLI; "Codex" runs the Codex CLI. The two
 * agents have different account models (Claude is multi-account; Codex
 * is single-account in v1) so the rest of the form keys off this
 * selection — see `NewSessionForm` for the conditional account row.
 *
 * Render shape: a flat segmented control of two pill buttons sharing
 * the dropdown trigger height (`h-9`), so it visually rhymes with the
 * adjacent Account / Model / Effort row. The selected button uses the
 * solid `default` variant; the unselected uses `outline` so the
 * selected one reads as the active state without any extra chrome.
 */
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
