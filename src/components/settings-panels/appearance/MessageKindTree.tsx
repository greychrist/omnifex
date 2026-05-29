import React from "react";
import { ChevronDown, ChevronRight, EyeOff, Lock, MessageSquare, Rows3 } from "lucide-react";
import { isHexColor, deriveKinds } from "@/lib/messageRenderingConfig";
import type {
  MessageRenderingConfig,
  MessageKindConfig,
} from "@/lib/messageRenderingConfig";
import { IconRenderer } from "./iconMap";
import { cn } from "@/lib/utils";

/**
 * Tree groups mirror the catalog's `origin` field exactly. The catalog
 * is the source of truth — don't infer from the kind ID. Originally we
 * had a catch-all "other" group that conflated bookkeeping records
 * (attachments, queue ops, etc.) with the fallback `unknown` row;
 * splitting them gives `unknown` its own dedicated section so a stray
 * "what is this thing?" entry is easy to find.
 */
type GroupId =
  | "assistant"
  | "user"
  | "system"
  | "cli"
  | "bookkeeping"
  | "fallback";

const GROUP_ORDER: GroupId[] = [
  "assistant",
  "user",
  "system",
  "cli",
  "bookkeeping",
  "fallback",
];

const GROUP_LABELS: Record<GroupId, string> = {
  assistant: "Assistant message",
  user: "User message",
  system: "System",
  cli: "CLI stream",
  bookkeeping: "Bookkeeping",
  fallback: "Fallback",
};

function groupOf(kind: MessageKindConfig): GroupId {
  switch (kind.origin) {
    case "assistant": return "assistant";
    case "user":      return "user";
    case "system":    return "system";
    case "cli":       return "cli";
    case "bookkeeping": return "bookkeeping";
    case "fallback":  return "fallback";
  }
}

interface MessageKindTreeProps {
  config: MessageRenderingConfig;
  selectedId: string;
  onSelect: (id: string) => void;
}

export const MessageKindTree: React.FC<MessageKindTreeProps> = ({
  config,
  selectedId,
  onSelect,
}) => {
  const [collapsed, setCollapsed] = React.useState<Record<GroupId, boolean>>({} as Record<GroupId, boolean>);

  const groups: Record<GroupId, MessageKindConfig[]> = {
    assistant: [],
    user: [],
    system: [],
    cli: [],
    bookkeeping: [],
    fallback: [],
  };
  const kinds = deriveKinds(config);
  for (const id of Object.keys(kinds)) {
    const k = kinds[id];
    groups[groupOf(k)].push(k);
  }
  // Sort each group by the visible label (A→Z) so the list reads in
  // alphabetical order. Related kinds that share a label prefix
  // (e.g. "Notification (…)", "Hook …") naturally cluster anyway.
  for (const group of GROUP_ORDER) {
    groups[group].sort((a, b) => a.label.localeCompare(b.label));
  }

  return (
    <div className="text-sm">
      {GROUP_ORDER.map((group) => {
        const kinds = groups[group];
        if (kinds.length === 0) return null;
        const isCollapsed = collapsed[group];
        return (
          <div key={group} className="mb-1">
            <button
              type="button"
              onClick={() => { setCollapsed((c) => ({ ...c, [group]: !isCollapsed })); }}
              className="w-full flex items-center gap-1 px-2 py-1 rounded hover:bg-muted/40 text-label uppercase tracking-wider text-muted-foreground"
            >
              {isCollapsed ? (
                <ChevronRight className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              {GROUP_LABELS[group]}
              <span className="ml-auto text-[10px] text-muted-foreground/70">
                {kinds.length}
              </span>
            </button>
            {!isCollapsed && (
              <div className="ml-3 border-l border-border/40 pl-1">
                {kinds.map((k) => (
                  <TreeRow
                    key={k.id}
                    kind={k}
                    palette={config.palette}
                    selected={k.id === selectedId}
                    onSelect={onSelect}
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

interface TreeRowProps {
  kind: MessageKindConfig;
  palette: MessageRenderingConfig["palette"];
  selected: boolean;
  onSelect: (id: string) => void;
}

const TreeRow: React.FC<TreeRowProps> = ({ kind, palette, selected, onSelect }) => {
  // `kind.accentColor` is either a palette name (legacy) or a hex string
  // (picker-driven). Resolve to a swatch hex either way.
  const swatch = isHexColor(kind.accentColor)
    ? kind.accentColor
    : (palette[kind.accentColor as keyof typeof palette]?.swatch ?? "#888");
  return (
    <button
      type="button"
      onClick={() => { onSelect(kind.id); }}
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1 rounded text-left transition-colors",
        selected ? "bg-primary/10 text-foreground" : "hover:bg-muted/40 text-foreground/80",
      )}
      title={kind.description}
    >
      {/* Presentation indicator, tinted with the accent swatch: a card
          glyph for `card` kinds, stacked rows for `side-line` kinds. */}
      <span className="flex-shrink-0" style={{ color: swatch }} aria-hidden="true">
        {kind.presentation === "card" ? (
          <MessageSquare className="h-3.5 w-3.5" />
        ) : (
          <Rows3 className="h-3.5 w-3.5" />
        )}
      </span>
      <span className="text-muted-foreground flex-shrink-0">
        <IconRenderer name={kind.icon} className="h-3.5 w-3.5" />
      </span>
      <span className="flex-1 text-[11px] leading-tight">{kind.label}</span>
      {kind.compactBoundaryLocked && (
        <Lock
          className="h-3 w-3 text-muted-foreground/60 flex-shrink-0"
          aria-label="Always visible — turn boundary"
        />
      )}
      {kind.hiddenInCompact && !kind.compactBoundaryLocked && (
        <EyeOff
          className="h-3 w-3 text-muted-foreground/60 flex-shrink-0"
          aria-label="Hidden in compact mode"
        />
      )}
    </button>
  );
};
