import React from "react";
import { CARD_BORDER_RADIUS_MAX, type MessageRenderingConfig } from "@/lib/messageRenderingConfig";
import { cn } from "@/lib/utils";
import { EditorRow } from "./EditorRow";

type ViewMode = MessageRenderingConfig["defaultViewMode"];

interface AllCardsEditorProps {
  defaultViewMode: ViewMode;
  cardBorderOpacity: number;
  cardBorderRadius: number;
  onDefaultViewMode: (mode: ViewMode) => void;
  onCardBorderOpacity: (pct: number) => void;
  onCardBorderRadius: (px: number) => void;
}

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: "verbose", label: "Verbose" },
  { value: "compact", label: "Compact" },
];

/**
 * Appearance › Message kinds › All cards: what applies to every card rather
 * than one kind. Laid out like the kind editor beside it.
 */
export const AllCardsEditor: React.FC<AllCardsEditorProps> = ({
  defaultViewMode,
  cardBorderOpacity,
  cardBorderRadius,
  onDefaultViewMode,
  onCardBorderOpacity,
  onCardBorderRadius,
}) => (
  <div className="space-y-3" data-testid="all-cards-editor">
    <header className="pb-2 border-b border-border">
      <h4 className="text-heading-4">All cards</h4>
      <p className="text-caption text-muted-foreground mt-0.5">
        Settings that apply to every message, whatever its kind.
      </p>
    </header>

    <EditorRow name="Default view">
      <div
        role="radiogroup"
        aria-label="Default view mode"
        className="inline-flex shrink-0 gap-0.5 rounded-md border border-input p-0.5"
      >
        {VIEW_MODES.map((m) => {
          const checked = defaultViewMode === m.value;
          return (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => { onDefaultViewMode(m.value); }}
              className={cn(
                "rounded px-2 py-1 text-xs transition-colors",
                checked ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-muted/40",
              )}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <span className="text-[11px] text-muted-foreground truncate">How a session opens.</span>
    </EditorRow>

    <EditorRow name="Border opacity">
      <input
        id="card-border-opacity"
        type="range"
        min={0}
        max={100}
        step={5}
        value={cardBorderOpacity}
        aria-label="Card border opacity"
        onChange={(e) => { onCardBorderOpacity(parseInt(e.target.value, 10)); }}
        className="min-w-0 flex-1 cursor-pointer accent-foreground"
      />
      <span className="font-mono text-[10px] text-muted-foreground w-9 text-right">
        {cardBorderOpacity}%
      </span>
    </EditorRow>

    <EditorRow name="Corner radius">
      <input
        id="card-border-radius"
        type="range"
        min={0}
        max={CARD_BORDER_RADIUS_MAX}
        step={1}
        value={cardBorderRadius}
        aria-label="Card corner radius"
        onChange={(e) => { onCardBorderRadius(parseInt(e.target.value, 10)); }}
        className="min-w-0 flex-1 cursor-pointer accent-foreground"
      />
      <span className="font-mono text-[10px] text-muted-foreground w-9 text-right">
        {cardBorderRadius}px
      </span>
    </EditorRow>
  </div>
);
