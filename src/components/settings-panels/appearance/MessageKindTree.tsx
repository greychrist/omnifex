import React from "react";
import { ChevronDown, ChevronRight, EyeOff, Lock } from "lucide-react";
import { CATEGORIES, KIND_REGISTRY, resolveKind, isHexColor, isHiddenInStandard } from "@/lib/messageRenderingConfig";
import type { Category, IconName, MessageRenderingConfig } from "@/lib/messageRenderingConfig";
import { MODERN_ITEM_KINDS } from "@/lib/renderingConfigMigration";
import { IconRenderer } from "./iconMap";
import { cn } from "@/lib/utils";

/**
 * The settings tree is grouped by category. Each of the four categories is a
 * selectable node (opens the category's style editor) that expands to show
 * the registry kinds belonging to that category, sorted alphabetically by label.
 * Selecting a kind row opens its kind editor.
 *
 * Only kinds whose settings change what is drawn are listed. The kinds Modern
 * draws as its own items (prompts, answers, thinking, tool calls…) take
 * their look from the step settings above and are always in Standard.
 * `assistant.text.live` is the streaming reply, never a record.
 */
const LISTED = (id: string, config: MessageRenderingConfig) =>
  id !== "assistant.text.live"
  // Except one hidden in Standard (a v5 Never migrates to that), so it can
  // be shown again.
  && (!MODERN_ITEM_KINDS.has(id) || isHiddenInStandard(resolveKind(config, id)));

export type TreeSelection =
  | { type: "category"; id: Category }
  | { type: "kind"; id: string };

interface MessageKindTreeProps {
  config: MessageRenderingConfig;
  selected: TreeSelection;
  onSelect: (selection: TreeSelection) => void;
}

/** Swatch hex for a resolved style's accent; grey when it is not a hex. */
function swatchHex(accentColor: string): string {
  return isHexColor(accentColor) ? accentColor : "#888";
}

export const MessageKindTree: React.FC<MessageKindTreeProps> = ({
  config,
  selected,
  onSelect,
}) => {
  // Starts collapsed: 50-odd kinds open at once buried the categories.
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<Category>>(() => new Set(CATEGORIES));
  const anyOpen = collapsed.size < CATEGORIES.length;
  const toggle = (c: Category) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  };

  return (
    <div role="tree" aria-label="Message kinds" className="text-sm space-y-1">
      <div className="flex justify-end px-1">
        <button
          type="button"
          onClick={() => { setCollapsed(anyOpen ? new Set(CATEGORIES) : new Set()); }}
          className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          {anyOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>
      {CATEGORIES.map((c) => {
        const catStyle = config.categories[c];
        const kinds = Object.values(KIND_REGISTRY)
          .filter((d) => d.category === c && LISTED(d.id, config))
          .sort((a, b) => a.label.localeCompare(b.label));
        const isOpen = !collapsed.has(c);
        const swatch = swatchHex(catStyle.accentColor);
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
                <span className="text-[10px] text-muted-foreground/70">{kinds.length}</span>
              </button>
            </div>

            {/* Kind rows */}
            {isOpen && (
              <div className="ml-4 border-l border-border/40 pl-1 mt-0.5 mb-1">
                {kinds.map((def) => {
                  const style = resolveKind(config, def.id);
                  const kindSwatch = swatchHex(style.accentColor);
                  const kindSelected = selected.type === "kind" && selected.id === def.id;
                  return (
                    <KindRow
                      key={def.id}
                      label={def.label}
                      icon={style.icon}
                      swatch={kindSwatch}
                      standard={style.standard}
                      alwaysShown={style.alwaysShown}
                      selected={kindSelected}
                      onSelect={() => { onSelect({ type: "kind", id: def.id }); }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

    </div>
  );
};

interface KindRowProps {
  label: string;
  icon: IconName;
  swatch: string;
  standard: boolean;
  alwaysShown?: boolean;
  selected: boolean;
  onSelect: () => void;
}

const KindRow: React.FC<KindRowProps> = ({ label, icon, swatch, standard, alwaysShown, selected, onSelect }) => (
  <div
    className={cn(
      "w-full flex items-center gap-2 px-2 py-1 rounded transition-colors",
      selected ? "bg-primary/10 text-foreground" : "hover:bg-muted/40 text-foreground/80",
    )}
  >
    <button
      type="button"
      onClick={onSelect}
      className="flex flex-1 min-w-0 items-center gap-2 text-left"
    >
      <span className="flex-shrink-0" style={{ color: swatch }} aria-hidden="true">
        <IconRenderer name={icon} className="h-3.5 w-3.5" />
      </span>
      <span className="flex-1 truncate text-[11px] leading-tight">{label}</span>
    </button>
    {alwaysShown && (
      <Lock className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" aria-label="Always shown — turn boundary" />
    )}
    {!standard && !alwaysShown && (
      <EyeOff className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" aria-label="Hidden in Standard" />
    )}
  </div>
);
