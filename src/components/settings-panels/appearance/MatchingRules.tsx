import React from "react";
import { Pencil } from "lucide-react";
import type { MatchCondition } from "@/lib/messageRenderingConfig";
import { formatMatchValue } from "./matchFormat";

export type MatchingRulesProps =
  | {
      kind: "category";
      categoryLabel: string;
      /** Read-only statement of how the classifier assigns messages here. */
      description: string;
    }
  | {
      kind: "override";
      label: string;
      categoryLabel: string;
      match: MatchCondition[];
      onEdit: () => void;
    };

/**
 * Read-only summary of the active selection's matching rules, shown under the
 * Sample. For a category it states how the classifier fills it (matching isn't
 * user-editable). For an override it lists the conditions as `path op value`
 * rows and offers an "Edit rules" affordance that opens the centered dialog.
 */
export const MatchingRules: React.FC<MatchingRulesProps> = (props) => {
  if (props.kind === "category") {
    return (
      <div className="rounded-md border border-border/60 bg-muted/10 px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-caption font-medium text-foreground/90">{props.categoryLabel} category</span>
          <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">classifier-assigned</span>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">{props.description}</p>
      </div>
    );
  }

  const { label, categoryLabel, match, onEdit } = props;
  return (
    <div className="rounded-md border border-border/60 bg-muted/10 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="text-caption font-medium text-foreground/90 truncate">{label}</span>
          <span className="text-[11px] text-muted-foreground"> · inherits {categoryLabel}</span>
        </div>
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit rules"
          className="shrink-0 inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          <Pencil className="h-3 w-3" /> Edit rules
        </button>
      </div>
      <div className="mt-1.5 space-y-0.5">
        {match.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/80 italic">
            matches all {categoryLabel} messages
          </p>
        ) : (
          match.map((c, i) => (
            <div key={i} className="font-mono text-[11px] text-foreground/80">
              <span className="text-foreground">{c.path}</span>{" "}
              <span className="text-muted-foreground">{c.op}</span>{" "}
              <span className="text-foreground">{formatMatchValue(c.value)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
