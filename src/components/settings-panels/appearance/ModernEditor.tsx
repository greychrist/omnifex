import React from "react";
import { Undo2 } from "lucide-react";
import {
  DEFAULT_MODERN,
  MODERN_ANSWER_SIZES,
  MODERN_PERCENT_MAX,
  MODERN_STEP_KINDS,
  modernCssVars,
  type MessageRenderingConfig,
  type ModernFont,
  type ModernStepKind,
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
import { IconPicker } from "./IconPicker";
import { ColorField } from "./HiddenEventsEditor";
import { cn } from "@/lib/utils";

/** What each step kind is called here — and what `stepKind` files under it. */
const STEP_LABELS: Record<ModernStepKind, { label: string; hint: string }> = {
  thought: { label: "Thought", hint: "Claude thinking" },
  command: { label: "Command", hint: "Bash" },
  commit: { label: "Commit", hint: "git commit" },
  branch: { label: "Branch", hint: "git checkout -b / switch -c" },
  read: { label: "Read", hint: "Read" },
  edit: { label: "Edit", hint: "Edit, MultiEdit, NotebookEdit" },
  create: { label: "Create", hint: "Write" },
  search: { label: "Search", hint: "Grep" },
  explore: { label: "Explore", hint: "Glob, LS" },
  web: { label: "Web", hint: "WebSearch, WebFetch" },
  agent: { label: "Agent", hint: "Agent, Task" },
  tasks: { label: "Tasks", hint: "TodoWrite, Task tools" },
  question: { label: "Question", hint: "AskUserQuestion" },
  skill: { label: "Skill", hint: "Skill" },
  mcp: { label: "MCP tool", hint: "mcp__*" },
  tool: { label: "Other tool", hint: "anything else" },
};

const TIMELINE_OPTIONS: { value: TimelineOpen; label: string }[] = [
  { value: "while-running", label: "Open while running" },
  { value: "always", label: "Always open" },
  { value: "never", label: "Always folded" },
];

const FONT_OPTIONS: { value: ModernFont; label: string }[] = [
  { value: "geist", label: "Geist" },
  { value: "content", label: "Typography font" },
];

/** A row of mutually exclusive buttons — a radio group, so it reads as one. */
function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-muted/30 p-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => { onChange(o.value); }}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-medium transition-all",
            value === o.value ? "bg-background shadow-sm" : "hover:bg-background/50",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A card's saturation or brightness, as a percent of its built-in — the
 *  colour's hue stays put. A reset back to 100% once it is moved. */
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

/** A soft drop shadow under the card, tinted its own colour. Disabled while
 *  the card's colour is off — it would shadow an invisible card. */
function ShadowField({ name, checked, disabled = false, onChange }: { name: string; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  const id = `modern-shadow-${name.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="flex items-center gap-3">
      <Switch id={id} aria-label={`${name} drop shadow`} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <Label htmlFor={id} className="text-caption">Drop shadow</Label>
    </div>
  );
}

/** The line between two sections. `bg-border`, not a border: the unlayered
 *  `* { border-color }` reset in styles.css beats border-colour utilities. */
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

const SAMPLE_CTX: ModernRowContext = { lookupsFor: () => ({}) as never, tabId: "settings-modern-sample" };

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
  const setIcon = (kind: ModernStepKind, icon: ModernStyle["stepIcons"][ModernStepKind]) => {
    onChange({ ...m, stepIcons: { ...m.stepIcons, [kind]: icon } });
  };

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
        <Label>Work timeline</Label>
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
        <Label id="modern-colors-heading">Colors</Label>
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
            <PercentField name="Answer card" label="Saturation" value={m.answerCardSaturation} disabled={!m.answerCardColorEnabled} onChange={(v) => { patch({ answerCardSaturation: v }); }} />
            <PercentField name="Answer card" label="Brightness" value={m.answerCardBrightness} disabled={!m.answerCardColorEnabled} onChange={(v) => { patch({ answerCardBrightness: v }); }} />
            <ShadowField name="Answer card" checked={m.answerCardShadow} disabled={!m.answerCardColorEnabled} onChange={(v) => { patch({ answerCardShadow: v }); }} />
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

      <SectionRule />

      <section className="space-y-3">
        <Label>Step icons</Label>
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
          {MODERN_STEP_KINDS.map((kind) => {
            const changed = m.stepIcons[kind] !== DEFAULT_MODERN.stepIcons[kind];
            return (
              <div
                key={kind}
                role="group"
                aria-label={`${STEP_LABELS[kind].label} step icon`}
                className="grid grid-cols-[minmax(0,1fr)_10rem_1.25rem] items-center gap-2"
              >
                <div className="min-w-0">
                  <div className="text-sm">{STEP_LABELS[kind].label}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{STEP_LABELS[kind].hint}</div>
                </div>
                <IconPicker value={m.stepIcons[kind]} onChange={(v) => { setIcon(kind, v); }} />
                {changed ? (
                  <button
                    type="button"
                    onClick={() => { setIcon(kind, DEFAULT_MODERN.stepIcons[kind]); }}
                    aria-label={`Reset ${STEP_LABELS[kind].label} icon`}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                  </button>
                ) : <span />}
              </div>
            );
          })}
        </div>
      </section>

      <SectionRule />

      <section className="space-y-3">
        <Label>Text</Label>
        <div className="flex flex-wrap items-center gap-6">
          <div className="space-y-1">
            <div className="text-caption text-muted-foreground">Font</div>
            <Segmented label="Font" value={m.font} options={FONT_OPTIONS} onChange={(v) => { patch({ font: v }); }} />
          </div>
          <div className="space-y-1">
            <div className="text-caption text-muted-foreground">Answer size</div>
            <Segmented
              label="Answer size"
              value={m.answerSize}
              options={MODERN_ANSWER_SIZES.map((s) => ({ value: s as number, label: `${String(s)}px` }))}
              onChange={(v) => { patch({ answerSize: v }); }}
            />
          </div>
        </div>
      </section>

    </div>
  );
};
