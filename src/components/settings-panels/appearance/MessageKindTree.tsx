import React from "react";
import { ChevronDown, ChevronRight, EyeOff, Lock } from "lucide-react";
import type {
  MessageRenderingConfig,
  MessageKindConfig,
} from "@/lib/messageRenderingConfig";
import { IconRenderer } from "./iconMap";
import { cn } from "@/lib/utils";

/**
 * Groups in the tree mirror the SDK's message hierarchy: assistant /
 * user are content-block parents (their child kinds are blocks within
 * one message); the rest are leaf message types.
 */
type GroupId =
  | "assistant"
  | "user"
  | "system"
  | "result"
  | "other";

const GROUP_ORDER: GroupId[] = ["assistant", "user", "system", "result", "other"];

const GROUP_LABELS: Record<GroupId, string> = {
  assistant: "Assistant message",
  user: "User message",
  system: "System",
  result: "Turn result",
  other: "Other",
};

function groupOf(kindId: string): GroupId {
  if (kindId.startsWith("assistant.")) return "assistant";
  if (kindId.startsWith("user.")) return "user";
  if (kindId.startsWith("tool.result.")) return "user"; // tool_result blocks live inside user messages
  if (kindId.startsWith("system.")) return "system";
  if (kindId.startsWith("result.")) return "result";
  return "other";
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
    result: [],
    other: [],
  };
  for (const id of Object.keys(config.kinds)) {
    const k = config.kinds[id];
    groups[groupOf(id)].push(k);
  }

  return (
    <div className="text-sm">
      {GROUP_ORDER.map((group) => {
        const kinds = groups[group];
        if (kinds.length === 0) return null;
        const isCollapsed = collapsed[group] === true;
        return (
          <div key={group} className="mb-1">
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [group]: !isCollapsed }))}
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
