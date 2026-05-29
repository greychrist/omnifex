import React from "react";
import { ChevronDown, ChevronRight, EyeOff, Lock, MessageSquare, Plus, Rows3, Trash2, X } from "lucide-react";
import {
  CATEGORIES,
  DEFAULT_CATEGORIES,
  KNOWN_KIND_IDS,
  isHexColor,
  originOf,
  resolveKind,
} from "@/lib/messageRenderingConfig";
import type {
  Category,
  MessageRenderingConfig,
  KindStyle,
} from "@/lib/messageRenderingConfig";
import { IconRenderer } from "./iconMap";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The settings tree is now two-tier:
 *  - a **Categories** section listing the five top-level categories (each row
 *    opens an editor bound to `config.categories[c]`), and
 *  - an **Overrides** section listing `config.overrides` entries (each row
 *    opens an editor bound to that override; rows carry a remove affordance),
 * followed by an **Add override** control.
 */

export type TreeSelection =
  | { type: "category"; id: Category }
  | { type: "override"; id: string };

interface MessageKindTreeProps {
  config: MessageRenderingConfig;
  selected: TreeSelection;
  onSelect: (selection: TreeSelection) => void;
  onAddOverride: (id: string) => void;
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

export const MessageKindTree: React.FC<MessageKindTreeProps> = ({
  config,
  selected,
  onSelect,
  onAddOverride,
  onRemoveOverride,
}) => {
  const [overridesCollapsed, setOverridesCollapsed] = React.useState(false);
  const [categoriesCollapsed, setCategoriesCollapsed] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const overrideIds = Object.keys(config.overrides).sort((a, b) => a.localeCompare(b));

  // Kind ids that already have an override are not offered again in the picker.
  const existing = new Set(overrideIds);

  return (
    <div className="text-sm">
      {/* ── Categories ── */}
      <div className="mb-2">
        <button
          type="button"
          onClick={() => { setCategoriesCollapsed((c) => !c); }}
          className="w-full flex items-center gap-1 px-2 py-1 rounded hover:bg-muted/40 text-label uppercase tracking-wider text-muted-foreground"
        >
          {categoriesCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          Categories
          <span className="ml-auto text-[10px] text-muted-foreground/70">{CATEGORIES.length}</span>
        </button>
        {!categoriesCollapsed && (
          <div className="ml-3 border-l border-border/40 pl-1">
            {CATEGORIES.map((c) => {
              const style = config.categories[c];
              return (
                <TreeRow
                  key={c}
                  label={style.label}
                  description={style.description}
                  style={style}
                  palette={config.palette}
                  selected={selected.type === "category" && selected.id === c}
                  onSelect={() => { onSelect({ type: "category", id: c }); }}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* ── Overrides ── */}
      <div className="mb-2">
        <button
          type="button"
          onClick={() => { setOverridesCollapsed((c) => !c); }}
          className="w-full flex items-center gap-1 px-2 py-1 rounded hover:bg-muted/40 text-label uppercase tracking-wider text-muted-foreground"
        >
          {overridesCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          Overrides
          <span className="ml-auto text-[10px] text-muted-foreground/70">{overrideIds.length}</span>
        </button>
        {!overridesCollapsed && (
          <div className="ml-3 border-l border-border/40 pl-1">
            {overrideIds.length === 0 && (
              <p className="px-2 py-1 text-[11px] text-muted-foreground/70 italic">
                No overrides — every kind rides its category default.
              </p>
            )}
            {overrideIds.map((id) => {
              const style = resolveKind(config, id);
              const label = config.overrides[id]?.label ?? id;
              return (
                <TreeRow
                  key={id}
                  label={label}
                  description={`id: ${id} · inherits ${config.categories[originOf(id)].label}`}
                  style={style}
                  palette={config.palette}
                  selected={selected.type === "override" && selected.id === id}
                  onSelect={() => { onSelect({ type: "override", id }); }}
                  onRemove={() => { onRemoveOverride(id); }}
                />
              );
            })}
          </div>
        )}
        <div className="ml-3 pl-1 mt-1">
          {pickerOpen ? (
            <AddOverridePicker
              existing={existing}
              onPick={(id) => {
                setPickerOpen(false);
                onAddOverride(id);
              }}
              onClose={() => { setPickerOpen(false); }}
            />
          ) : (
            <button
              type="button"
              onClick={() => { setPickerOpen(true); }}
              className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-left text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              Add override
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

interface TreeRowProps {
  label: string;
  description: string;
  style: KindStyle;
  palette: MessageRenderingConfig["palette"];
  selected: boolean;
  onSelect: () => void;
  onRemove?: () => void;
}

const TreeRow: React.FC<TreeRowProps> = ({ label, description, style, palette, selected, onSelect, onRemove }) => {
  const swatch = swatchHex(style.accentColor, palette);
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
        {/* Presentation indicator, tinted with the accent swatch. */}
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
        <span className="flex-1 truncate text-[11px] leading-tight">{label}</span>
      </button>
      {style.compactBoundaryLocked && (
        <Lock
          className="h-3 w-3 text-muted-foreground/60 flex-shrink-0"
          aria-label="Always visible — turn boundary"
        />
      )}
      {style.hiddenInCompact && !style.compactBoundaryLocked && (
        <EyeOff
          className="h-3 w-3 text-muted-foreground/60 flex-shrink-0"
          aria-label="Hidden in compact mode"
        />
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label} override`}
          title="Remove this override"
          className="flex-shrink-0 text-muted-foreground/50 hover:text-destructive opacity-0 group-hover/row:opacity-100 focus:opacity-100"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
};

interface AddOverridePickerProps {
  existing: Set<string>;
  onPick: (id: string) => void;
  onClose: () => void;
}

/**
 * Grouped picker for adding an override. Lists known classifier kind ids
 * grouped by `originOf`, omitting any id that already has an override, plus a
 * free-text field for entering an unseen id.
 */
const AddOverridePicker: React.FC<AddOverridePickerProps> = ({ existing, onPick, onClose }) => {
  const [freeText, setFreeText] = React.useState("");

  const grouped = React.useMemo(() => {
    const out: Record<Category, string[]> = {
      user: [], agent: [], system: [], attachment: [], bookkeeping: [],
    };
    for (const id of KNOWN_KIND_IDS) {
      if (existing.has(id)) continue;
      out[originOf(id)].push(id);
    }
    for (const c of CATEGORIES) out[c].sort((a, b) => a.localeCompare(b));
    return out;
  }, [existing]);

  const submitFree = () => {
    const id = freeText.trim();
    if (id) onPick(id);
  };

  return (
    <div className="rounded-md border border-border bg-background p-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-foreground">Add override</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cancel add override"
          className="text-muted-foreground/60 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div
        className="max-h-64 overflow-y-auto space-y-2"
        role="listbox"
        aria-label="Pick a kind to override"
      >
        {CATEGORIES.map((c) => {
          const ids = grouped[c];
          if (ids.length === 0) return null;
          return (
            <div key={c}>
              <div className="px-1 text-[9px] uppercase tracking-wider text-muted-foreground/70">
                {DEFAULT_CATEGORIES[c].label}
              </div>
              {ids.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => { onPick(id); }}
                  className="w-full text-left px-2 py-0.5 rounded text-[11px] font-mono text-foreground/80 hover:bg-muted/40 hover:text-foreground"
                >
                  {id}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5 pt-1 border-t border-border/60">
        <Input
          value={freeText}
          onChange={(e) => { setFreeText(e.target.value); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitFree(); } }}
          placeholder="or enter a kind id…"
          aria-label="Custom kind id"
          className="h-7 text-[11px] font-mono"
        />
        <button
          type="button"
          onClick={submitFree}
          disabled={freeText.trim() === ""}
          aria-label="Add custom override"
          className="flex-shrink-0 rounded-md border border-border px-2 h-7 text-[11px] text-foreground/80 hover:bg-muted/40 disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
};
