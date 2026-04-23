import React from "react";
import { ChevronDown, ChevronRight, EyeOff } from "lucide-react";
import type {
  MessageRenderingConfig,
  MessageKindConfig,
  Origin,
} from "@/lib/messageRenderingConfig";
import { IconRenderer } from "./iconMap";
import { cn } from "@/lib/utils";

const ORIGIN_ORDER: Origin[] = ["user", "assistant", "tool", "system", "subagent"];

const ORIGIN_LABELS: Record<Origin, string> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
  system: "System",
  subagent: "Subagent",
};

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
  const [collapsed, setCollapsed] = React.useState<Record<Origin, boolean>>({} as Record<Origin, boolean>);

  const groups: Record<Origin, MessageKindConfig[]> = {
    user: [],
    assistant: [],
    tool: [],
    system: [],
    subagent: [],
  };
  for (const id of Object.keys(config.kinds)) {
    const k = config.kinds[id];
    groups[k.origin].push(k);
  }

  return (
    <div className="text-sm">
      {ORIGIN_ORDER.map((origin) => {
        const kinds = groups[origin];
        if (kinds.length === 0) return null;
        const isCollapsed = collapsed[origin] === true;
        return (
          <div key={origin} className="mb-1">
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [origin]: !isCollapsed }))}
              className="w-full flex items-center gap-1 px-2 py-1 rounded hover:bg-muted/40 text-label uppercase tracking-wider text-muted-foreground"
            >
              {isCollapsed ? (
                <ChevronRight className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              {ORIGIN_LABELS[origin]}
              <span className="ml-auto text-[10px] text-muted-foreground/70">
                {kinds.length}
              </span>
            </button>
            {!isCollapsed && (
              <div className="ml-1">
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
  const entry = palette[kind.accentColor];
  return (
    <button
      type="button"
      onClick={() => onSelect(kind.id)}
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors",
        selected ? "bg-primary/10 text-foreground" : "hover:bg-muted/40 text-foreground/80",
      )}
      title={kind.description}
    >
      <span
        className="h-2.5 w-2.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: entry.swatch }}
      />
      <span className="text-muted-foreground flex-shrink-0">
        <IconRenderer name={kind.icon} className="h-3.5 w-3.5" />
      </span>
      <span className="flex-1 truncate text-xs">{kind.label}</span>
      {kind.hiddenInCompact && (
        <EyeOff
          className="h-3 w-3 text-muted-foreground/60 flex-shrink-0"
          aria-label="Hidden in compact mode"
        />
      )}
    </button>
  );
};
