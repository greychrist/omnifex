import { Segmented } from "./Segmented";
import React from "react";
import { Undo2 } from "lucide-react";
import {
  MODERN_PERCENT_MAX,
  modernCssVars,
  type MessageRenderingConfig,
  type ModernAnswerStyle,
  type ModernStyle,
  type TimelineOpen,
} from "@/lib/messageRenderingConfig";
import type { JsonlNode } from "@/types/jsonl";
import type { ModernItem } from "@/lib/modernGrouping";
import { MessageRenderingPreviewProvider } from "@/contexts/MessageRenderingContext";
import { ModernTranscriptItem, type ModernRowContext } from "@/components/transcript-modern/ModernTranscriptItem";
import type { TurnFooter } from "@/lib/modernTurnFooter";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ColorField } from "./ColorField";

const TIMELINE_OPTIONS: { value: TimelineOpen; label: string }[] = [
  { value: "while-running", label: "Open while running" },
  { value: "always", label: "Always open" },
  { value: "never", label: "Always folded" },
];

const ANSWER_STYLE_OPTIONS: { value: ModernAnswerStyle; label: string }[] = [
  { value: "card", label: "Card" },
  { value: "line", label: "Line" },
];


/** A card's saturation or brightness, as a percent of its built-in — the
 *  color's hue stays put. A reset back to 100% once it is moved. */
function PercentField({ name, label, value, disabled = false, onChange }: {
  name: string;
  /** "Saturation" or "Brightness". */
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  const what = label.toLowerCase();
  const id = `modern-${what}-${name.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-caption text-muted-foreground">{label}</Label>
        {value !== BUILT_IN_PERCENT ? (
          <button
            type="button"
            onClick={() => { onChange(BUILT_IN_PERCENT); }}
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
            aria-label={`Reset ${name.toLowerCase()} ${what}`}
          >
            <Undo2 className="h-3 w-3" />
            Reset to {BUILT_IN_PERCENT}%
          </button>
        ) : (
          <span className="text-[10px] text-muted-foreground/70 italic">built-in</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="range"
          min={0}
          max={MODERN_PERCENT_MAX}
          step={5}
          value={value}
          aria-label={`${name} ${what}`}
          disabled={disabled}
          onChange={(e) => { onChange(parseInt(e.target.value, 10)); }}
          className="flex-1 cursor-pointer accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
        />
        <span className="font-mono text-caption text-muted-foreground w-10 text-right">{value}%</span>
      </div>
    </div>
  );
}

const BUILT_IN_PERCENT = 100;

/** A soft drop shadow under the card, tinted its own color. Disabled while
 *  the card's color is off — it would shadow an invisible card. */
function ShadowField({ name, checked, disabled = false, onChange }: { name: string; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  const id = `modern-shadow-${name.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="flex items-center gap-3">
      <Switch id={id} aria-label={`${name} drop shadow`} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <Label htmlFor={id} className="text-caption">Drop shadow</Label>
    </div>
  );
}

/** A section's title: a size up from the rows' own labels, so it reads as
 *  the heading over them rather than one more row. */
function SectionHeading({ id, children }: { id?: string; children: React.ReactNode }) {
  return <h4 id={id} className="text-body font-semibold">{children}</h4>;
}


/** The line between two sections. `bg-border`, not a border: the unlayered
 *  `* { border-color }` reset in styles.css beats border-color utilities. */
function SectionRule() {
  return <div role="separator" className="h-px w-full bg-border" />;
}

// ─── sample ─────────────────────────────────────────────────────────────────

const node = (uuid: string) => ({ kind: "assistant", raw: { uuid } }) as unknown as JsonlNode;

/** One made-up turn: a prompt, a run of work with a thought and a failure,
 *  and an answer — enough to show every setting on this tab. */
const SAMPLE_ITEMS: ModernItem[] = [
  { kind: "prompt", key: "p", node: node("p"), text: "Why does the composer jump while I type?" },
  {
    kind: "work",
    key: "w",
    nodes: [],
    entries: [
      { type: "thinking", key: "t", node: node("t"), text: "The textarea's min-height animates…", ms: 3000, tokens: null },
      { type: "tool", key: "r", node: node("r"), id: "r", name: "Read", input: { file_path: "src/components/FloatingPromptInput.tsx" }, status: "done" },
      { type: "tool", key: "g", node: node("g"), id: "g", name: "Grep", input: { pattern: "scrollHeight" }, status: "done" },
      { type: "tool", key: "e", node: node("e"), id: "e", name: "Edit", input: { file_path: "src/components/FloatingPromptInput.tsx", old_string: "a", new_string: "b" }, status: "done" },
      { type: "tool", key: "b", node: node("b"), id: "b", name: "Bash", input: { command: "npm test" }, status: "error" },
    ],
  },
  {
    kind: "text",
    key: "a",
    node: node("a"),
    text: "Its height **animated** on every new line, so for 150ms the box was shorter than its text. The height no longer animates.",
  },
];

const SAMPLE_CTX: ModernRowContext = { tabId: "settings-modern-sample" };

/** The sample's answer ends its turn, so it carries the Done line. */
const SAMPLE_FOOTER: TurnFooter = { ms: 252_000, steps: 4, usd: 0.38 };

/** The real Modern components, drawn against the draft config. */
const ModernSample: React.FC<{ config: MessageRenderingConfig }> = ({ config }) => {
  const vars = Object.fromEntries(
    Object.entries(modernCssVars(config.modern)).filter(([, v]) => v !== null),
  ) as React.CSSProperties;
  return (
    <MessageRenderingPreviewProvider config={config}>
      <div
        role="region"
        aria-label="Modern sample"
        className="modern-format space-y-4 rounded-md border border-border bg-background p-4"
        style={vars}
      >
        {SAMPLE_ITEMS.map((item) => (
          <ModernTranscriptItem key={item.key} item={item} live={false} ctx={SAMPLE_CTX} footer={item.key === "a" ? SAMPLE_FOOTER : undefined} />
        ))}
      </div>
    </MessageRenderingPreviewProvider>
  );
};

// ─── editor ─────────────────────────────────────────────────────────────────

interface ModernEditorProps {
  config: MessageRenderingConfig;
  onChange: (next: ModernStyle) => void;
}

export const ModernEditor: React.FC<ModernEditorProps> = ({ config, onChange }) => {
  const m = config.modern;
  const patch = (p: Partial<ModernStyle>) => { onChange({ ...m, ...p }); };

  return (
    <div data-testid="modern-editor" className="space-y-6">
      <div>
        <h3 className="text-heading-4">Modern</h3>
        <p className="text-caption text-muted-foreground mt-1">
          How the Modern chat format looks. Message kinds and Turn preview style the other formats.
        </p>
      </div>

      <ModernSample config={config} />


      <section className="space-y-3">
        <SectionHeading>Work timeline</SectionHeading>
        <p className="text-caption text-muted-foreground">
          The folding run of thoughts and tool calls between your prompt and Claude's answer.
        </p>
        <Segmented
          label="Work timeline"
          value={m.timelineOpen}
          options={TIMELINE_OPTIONS}
          onChange={(v) => { patch({ timelineOpen: v }); }}
        />
        <div className="flex items-center gap-3">
          <Switch
            id="modern-show-thoughts"
            aria-label="Show thoughts"
            checked={m.showThoughts}
            onCheckedChange={(v) => { patch({ showThoughts: v }); }}
          />
          <Label htmlFor="modern-show-thoughts" className="text-caption">Show thoughts</Label>
        </div>
      </section>

      <SectionRule />

      <section role="region" aria-labelledby="modern-colors-heading" className="space-y-3">
        <SectionHeading id="modern-colors-heading">Colors</SectionHeading>
        <p className="text-caption text-muted-foreground">
          Your prompt, the answer that ends a turn, and a failed step in the work timeline.
        </p>
        <div data-testid="modern-colors" className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <div className="space-y-3">
            <ColorField
              name="Prompt bubble"
              title="Prompt bubble"
              unsetLabel="built-in blue"
              value={m.promptTint}
              onChange={(v) => { patch({ promptTint: v }); }}
              enabled={m.promptColorEnabled}
              onEnabledChange={(v) => { patch({ promptColorEnabled: v }); }}
            />
            <PercentField name="Prompt bubble" label="Saturation" value={m.promptSaturation} disabled={!m.promptColorEnabled} onChange={(v) => { patch({ promptSaturation: v }); }} />
            <PercentField name="Prompt bubble" label="Brightness" value={m.promptBrightness} disabled={!m.promptColorEnabled} onChange={(v) => { patch({ promptBrightness: v }); }} />
            <ShadowField name="Prompt bubble" checked={m.promptShadow} disabled={!m.promptColorEnabled} onChange={(v) => { patch({ promptShadow: v }); }} />
          </div>
          <div className="space-y-3">
            <ColorField
              name="Answer card"
              title="Answer card"
              unsetLabel="built-in green"
              value={m.answerCardColor}
              onChange={(v) => { patch({ answerCardColor: v }); }}
              enabled={m.answerCardColorEnabled}
              onEnabledChange={(v) => { patch({ answerCardColorEnabled: v }); }}
            />
            {/* Line: a bar down the answer's left edge in this color. The
                card's fill strength and shadow have nothing to act on. */}
            <Segmented
              label="Answer style"
              value={m.answerStyle}
              options={ANSWER_STYLE_OPTIONS}
              onChange={(v) => { patch({ answerStyle: v }); }}
            />
            <PercentField name="Answer card" label="Saturation" value={m.answerCardSaturation} disabled={!m.answerCardColorEnabled || m.answerStyle === "line"} onChange={(v) => { patch({ answerCardSaturation: v }); }} />
            <PercentField name="Answer card" label="Brightness" value={m.answerCardBrightness} disabled={!m.answerCardColorEnabled || m.answerStyle === "line"} onChange={(v) => { patch({ answerCardBrightness: v }); }} />
            <ShadowField name="Answer card" checked={m.answerCardShadow} disabled={!m.answerCardColorEnabled || m.answerStyle === "line"} onChange={(v) => { patch({ answerCardShadow: v }); }} />
          </div>
          <div className="space-y-3">
            <ColorField
              name="Failed step"
              title="Failed step"
              unsetLabel="theme red"
              value={m.failedColor}
              onChange={(v) => { patch({ failedColor: v }); }}
            />
          </div>
        </div>
      </section>


    </div>
  );
};
