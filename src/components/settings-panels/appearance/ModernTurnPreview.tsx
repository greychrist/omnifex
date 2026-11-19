import React from "react";
import type { JsonlNode } from "@/types/jsonl";
import { classifyJsonlLine } from "@/lib/jsonlClassifier";
import { normalizeJsonlNode } from "@/lib/normalizeMessage";
import { modernCssVars, type MessageRenderingConfig, type ViewMode } from "@/lib/messageRenderingConfig";
import { transcriptItems } from "@/lib/transcriptItems";
import { modernTurnFooters } from "@/lib/modernTurnFooter";
import { MessageRenderingPreviewProvider } from "@/contexts/MessageRenderingContext";
import { ModernTranscriptItem, type ModernRowContext } from "@/components/transcript-modern/ModernTranscriptItem";
import { cn } from "@/lib/utils";

const at = (s: number) => new Date(Date.UTC(2026, 10, 18, 9, 0, s)).toISOString();

/** One turn with the records a session usually carries: the conversation,
 *  a tool run, and bookkeeping that only Expanded shows by default. */
const RAW_TURN: Record<string, unknown>[] = [
  { type: "user", uuid: "p1", timestamp: at(0), message: { role: "user", content: [{ type: "text", text: "Why is the login test failing?" }] } },
  { type: "permission-mode", uuid: "pm", timestamp: at(1), permissionMode: "acceptEdits" },
  { type: "assistant", uuid: "a1", timestamp: at(2), message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "Read the test, then the token check.", signature: "s" }] } },
  { type: "assistant", uuid: "a2", timestamp: at(3), message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth/login.ts" } }] } },
  { type: "user", uuid: "r1", timestamp: at(4), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "export function login() { … }" }] } },
  { type: "ai-title", uuid: "ti", timestamp: at(5), aiTitle: "Fix the login test" },
  { type: "assistant", uuid: "a3", timestamp: at(9), message: { id: "m3", role: "assistant", content: [{ type: "text", text: "The token check is inverted: it rejects valid tokens. Flipping the comparison fixes it." }] } },
];

const PREVIEW_TURN: JsonlNode[] = RAW_TURN
  .map((r) => classifyJsonlLine(r))
  .filter((n): n is NonNullable<typeof n> => n !== null)
  .map((n) => normalizeJsonlNode(n));

const PREVIEW_CTX: ModernRowContext = { tabId: "settings-turn-preview" };
const VIEWS: { value: ViewMode; label: string }[] = [
  { value: "standard", label: "Standard" },
  { value: "expanded", label: "Expanded" },
];

/**
 * Settings › Chats › Turn preview: one turn drawn by the real Modern renderer
 * against the draft config, in either view, so a kind's icon, color or
 * Show in Standard can be seen changing.
 */
export const ModernTurnPreview: React.FC<{ config: MessageRenderingConfig }> = ({ config }) => {
  const [view, setView] = React.useState<ViewMode>("standard");
  const items = React.useMemo(() => transcriptItems(PREVIEW_TURN, config, view), [config, view]);
  const footers = React.useMemo(() => modernTurnFooters(items, PREVIEW_TURN, false), [items]);
  const vars = Object.fromEntries(
    Object.entries(modernCssVars(config.modern)).filter(([, v]) => v !== null),
  ) as React.CSSProperties;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-heading-4">Turn preview</h3>
          <p className="text-caption text-muted-foreground mt-1">
            One turn, as a session draws it. Standard leaves out what Messages hides; Expanded shows every record.
          </p>
        </div>
        <div role="radiogroup" aria-label="Preview view" className="flex items-center gap-1 p-1 bg-muted/30 rounded-lg">
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              role="radio"
              aria-checked={view === v.value}
              onClick={() => { setView(v.value); }}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                view === v.value ? "bg-background shadow-sm" : "hover:bg-background/50",
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <MessageRenderingPreviewProvider config={config}>
        <div
          role="region"
          aria-label="Turn preview"
          className="modern-format space-y-4 rounded-md border border-border bg-background p-4"
          style={vars}
        >
          {items.map((item) => (
            <ModernTranscriptItem key={item.key} item={item} live={false} ctx={PREVIEW_CTX} footer={footers.get(item.key)} />
          ))}
        </div>
      </MessageRenderingPreviewProvider>
    </div>
  );
};
