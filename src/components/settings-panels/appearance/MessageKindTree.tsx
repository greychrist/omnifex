import React from "react";
import { ChevronDown, ChevronRight, EyeOff, Lock, MessageSquare, Pencil, Plus, Rows3, Trash2 } from "lucide-react";
import { CATEGORIES, isHexColor } from "@/lib/messageRenderingConfig";
import type {
  Category,
  MessageRenderingConfig,
  KindStyle,
  Override,
} from "@/lib/messageRenderingConfig";
import { IconRenderer } from "./iconMap";
import { cn } from "@/lib/utils";

/**
 * The settings tree is grouped by category. Each of the five categories is a
 * selectable node (opens the category's style editor) that expands to show:
 *  - an **+ Add override** entry that opens the centered match dialog, and
 *  - that category's override rules (array order), each a selectable row with
 *    an Edit (✎, opens the match dialog) and Delete (🗑) action.
 */

export type TreeSelection =
  | { type: "category"; id: Category }
  | { type: "override"; id: string };

interface MessageKindTreeProps {
  config: MessageRenderingConfig;
  selected: TreeSelection;
  onSelect: (selection: TreeSelection) => void;
  onAddOverride: (category: Category) => void;
  onEditOverride: (id: string) => void;
  onRemoveOverride: (id: string) => void;
}

/** Swatch hex for a resolved style's accent (palette name or hex). */
function swatchHex(
  accentColor: string,
  palette: MessageRenderingConfig["palette"],
): string {
  return isHexColor(accentColor)
    ? accentColor
    : (palette[accentColor as keyof typeof palette]?.swatch ?? "#888");
}

/** Category base ⊕ the override's sparse style — the row's effective look. */
function overrideStyle(config: MessageRenderingConfig, o: Override): KindStyle {
  return { ...config.categories[o.category], ...o.style };
}

export const MessageKindTree: React.FC<MessageKindTreeProps> = ({
  config,
  selected,
  onSelect,
  onAddOverride,
  onEditOverride,
  onRemoveOverride,
}) => {
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<Category>>(new Set());
  const toggle = (c: Category) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  };

  return (
    <div className="text-sm space-y-1">
      {CATEGORIES.map((c) => {
        const catStyle = config.categories[c];
        const overrides = config.overrides.filter((o) => o.category === c);
        const isOpen = !collapsed.has(c);
        const swatch = swatchHex(catStyle.accentColor, config.palette);
        const catSelected = selected.type === "category" && selected.id === c;
        return (
          <div key={c}>
            {/* Category node */}
            <div
              className={cn(
                "group/cat w-full flex items-center gap-1 rounded px-1 py-1 transition-colors",
                catSelected ? "bg-primary/10 text-foreground" : "hover:bg-muted/40 text-foreground/90",
              )}
            >
              <button
                type="button"
                onClick={() => { toggle(c); }}
                aria-label={isOpen ? `Collapse ${catStyle.label}` : `Expand ${catStyle.label}`}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => { onSelect({ type: "category", id: c }); }}
                className="flex flex-1 min-w-0 items-center gap-2 text-left"
                title={catStyle.description}
              >
                <span className="shrink-0" style={{ color: swatch }} aria-hidden="true">
                  <IconRenderer name={catStyle.icon} className="h-3.5 w-3.5" />
                </span>
                <span className="flex-1 truncate text-[12px] font-medium">{catStyle.label}</span>
                <span className="text-[10px] text-muted-foreground/70">{overrides.length}</span>
              </button>
            </div>

            {/* Children */}
            {isOpen && (
              <div className="ml-4 border-l border-border/40 pl-1 mt-0.5 mb-1">
                <button
                  type="button"
                  onClick={() => { onAddOverride(c); }}
                  aria-label={`Add override to ${catStyle.label}`}
                  className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-left text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add override
                </button>
                {overrides.map((o) => (
                  <OverrideRow
                    key={o.id}
                    override={o}
                    style={overrideStyle(config, o)}
                    palette={config.palette}
                    selected={selected.type === "override" && selected.id === o.id}
                    onSelect={() => { onSelect({ type: "override", id: o.id }); }}
                    onEdit={() => { onEditOverride(o.id); }}
                    onRemove={() => { onRemoveOverride(o.id); }}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

interface OverrideRowProps {
  override: Override;
  style: KindStyle;
  palette: MessageRenderingConfig["palette"];
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

const OverrideRow: React.FC<OverrideRowProps> = ({ override, style, palette, selected, onSelect, onEdit, onRemove }) => {
  const swatch = swatchHex(style.accentColor, palette);
  const description = `${override.match.length} ${override.match.length === 1 ? "condition" : "conditions"}`;
  return (
    <div
      className={cn(
        "group/row w-full flex items-center gap-2 px-2 py-1 rounded transition-colors",
        selected ? "bg-primary/10 text-foreground" : "hover:bg-muted/40 text-foreground/80",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex flex-1 min-w-0 items-center gap-2 text-left"
        title={description}
      >
        <span className="flex-shrink-0" style={{ color: swatch }} aria-hidden="true">
          {style.presentation === "card" ? (
            <MessageSquare className="h-3.5 w-3.5" />
          ) : (
            <Rows3 className="h-3.5 w-3.5" />
          )}
        </span>
        <span className="text-muted-foreground flex-shrink-0">
          <IconRenderer name={style.icon} className="h-3.5 w-3.5" />
        </span>
        <span className="flex-1 truncate text-[11px] leading-tight">{override.label}</span>
      </button>
      {style.compactBoundaryLocked && (
        <Lock className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" aria-label="Always visible — turn boundary" />
      )}
      {style.hiddenInCompact && !style.compactBoundaryLocked && (
        <EyeOff className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" aria-label="Hidden in compact mode" />
      )}
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${override.label} rules`}
        title="Edit match rules"
        className="flex-shrink-0 text-muted-foreground/50 hover:text-foreground opacity-0 group-hover/row:opacity-100 focus:opacity-100"
      >
        <Pencil className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${override.label} override`}
        title="Remove this override"
        className="flex-shrink-0 text-muted-foreground/50 hover:text-destructive opacity-0 group-hover/row:opacity-100 focus:opacity-100"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
};
