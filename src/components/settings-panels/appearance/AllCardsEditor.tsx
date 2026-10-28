import React from "react";
import { CARD_BORDER_RADIUS_MAX } from "@/lib/messageRenderingConfig";
import { EditorRow } from "./EditorRow";

interface AllCardsEditorProps {
  cardBorderOpacity: number;
  cardBorderRadius: number;
  onCardBorderOpacity: (pct: number) => void;
  onCardBorderRadius: (px: number) => void;
}

/**
 * Appearance › Message kinds › All cards: what applies to every card rather
 * than one kind. Laid out like the kind editor beside it.
 */
export const AllCardsEditor: React.FC<AllCardsEditorProps> = ({
  cardBorderOpacity,
  cardBorderRadius,
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
