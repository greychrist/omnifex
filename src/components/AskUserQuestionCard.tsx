import { useMemo, useState } from "react";
import { Send, MessageCircleQuestion, ChevronUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { accentStyleFor, swatchFor } from "@/lib/accentStyle";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import type { PermissionRequestPayload } from "@/lib/types/permissionRequest";

/**
 * Custom-renderer card for the SDK's `AskUserQuestion` built-in tool.
 *
 * The Claude Agent SDK gates this tool through the same `canUseTool`
 * (permission_request) channel as Bash / Read / Write — but the right UX
 * is NOT "Allow / Deny". The agent is asking the *user* a multiple-choice
 * question and the runtime needs the user's selection back as the tool's
 * output. This card renders the questions + options exactly as authored
 * by the agent, collects answers, and on Submit responds with
 * `behavior: 'allow'` plus an `updatedInput` carrying the answers in the
 * shape the SDK's `AskUserQuestionOutput` documents:
 *
 *   {
 *     questions: <unchanged input>,
 *     answers: { [question]: string },   // multi-select → comma-separated
 *     annotations?: { [question]: { notes?: string } }
 *   }
 *
 * Per the SDK tool description, the host appends an "Other" option to
 * every question so the user can type a free-text answer (the agent
 * MUST NOT include "Other" itself). Selecting "Other" reveals a small
 * text field whose value becomes the answer.
 */

interface AskUserQuestionCardProps {
  request: PermissionRequestPayload;
  onSubmit: (updatedInput: Record<string, unknown>) => void;
  onCancel: () => void;
}

interface QuestionShape {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multiSelect?: boolean;
}

const OTHER_VALUE = '__omnifex_other__';

function parseQuestions(input: Record<string, unknown>): QuestionShape[] {
  const raw = input?.questions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
    .map((q) => ({
      question: typeof q.question === 'string' ? q.question : '(missing question)',
      header: typeof q.header === 'string' ? q.header : undefined,
      options: Array.isArray(q.options)
        ? q.options
            .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
            .map((o) => ({
              label: typeof o.label === 'string' ? o.label : '',
              description: typeof o.description === 'string' ? o.description : undefined,
              preview: typeof o.preview === 'string' ? o.preview : undefined,
            }))
            .filter((o) => o.label.length > 0)
        : [],
      multiSelect: q.multiSelect === true,
    }));
}

export function AskUserQuestionCard({ request, onSubmit, onCancel }: AskUserQuestionCardProps) {
  const { config } = useMessageRenderingConfig();
  // Mirror PermissionCard's container treatment: `accentStyle` paints the
  // outer card with the per-kind translucent border + bg, and `accentSwatch`
  // colors the question icon so per-kind theming (Settings → Chats) still
  // reads against the lighter inline surface.
  const accentStyle = accentStyleFor(config, 'permission.askUserQuestion');
  const accentSwatch = swatchFor(config, 'permission.askUserQuestion');

  const questions = useMemo(() => parseQuestions(request.toolInput), [request.toolInput]);

  // selections[i]: for single-select → string | null. for multi-select → string[].
  // For both modes the special value `OTHER_VALUE` means "user picked Other"
  // and the actual text lives in `otherTexts[i]`.
  const [selections, setSelections] = useState<Array<string | string[] | null>>(
    () => questions.map((q) => (q.multiSelect ? [] : null)),
  );
  const [otherTexts, setOtherTexts] = useState<string[]>(() => questions.map(() => ''));
  // When the SDK sends 3-4 questions with previews the card can occupy
  // ~60vh, hiding the chat context the user wants to consult before
  // answering. Collapsing drops everything below the header so that
  // context is visible again; submit stays gated on re-expanding so the
  // user can't fire off answers they can no longer see.
  const [collapsed, setCollapsed] = useState(false);

  const isComplete = questions.every((q, i) => {
    const sel = selections[i];
    const sentinelPicked = q.multiSelect
      ? Array.isArray(sel) && sel.includes(OTHER_VALUE)
      : sel === OTHER_VALUE;
    if (sentinelPicked && !otherTexts[i].trim()) return false;
    return q.multiSelect
      ? Array.isArray(sel) && sel.length > 0
      : typeof sel === 'string' && sel.length > 0;
  });

  const togglePick = (i: number, label: string) => {
    setSelections((prev) => {
      const next = prev.slice();
      const q = questions[i];
      if (q.multiSelect) {
        const list = Array.isArray(next[i]) ? (next[i] as string[]) : [];
        next[i] = list.includes(label) ? list.filter((l) => l !== label) : [...list, label];
      } else {
        next[i] = next[i] === label ? null : label;
      }
      return next;
    });
  };

  const setOtherText = (i: number, value: string) => {
    setOtherTexts((prev) => {
      const next = prev.slice();
      next[i] = value;
      return next;
    });
  };

  const handleSubmit = () => {
    // Resolve each question's final answer string. Multi-select joins picks
    // with ', ' per the SDK's documented `answers` value format.
    const answers: Record<string, string> = {};
    const annotations: Record<string, { notes?: string }> = {};
    questions.forEach((q, i) => {
      const sel = selections[i];
      const otherText = otherTexts[i].trim();
      const picksRaw = q.multiSelect
        ? (Array.isArray(sel) ? sel : [])
        : (typeof sel === 'string' ? [sel] : []);
      // Replace the Other sentinel with the typed text.
      const picks = picksRaw.map((p) => (p === OTHER_VALUE ? otherText : p)).filter(Boolean);
      answers[q.question] = picks.join(', ');
      // Note "Other" responses so the agent can see they were free-text.
      if (picksRaw.includes(OTHER_VALUE)) {
        annotations[q.question] = { notes: `User selected Other: "${otherText}"` };
      }
    });

    const updatedInput: Record<string, unknown> = {
      // Echo the original questions back unchanged — the SDK's output
      // schema requires both `questions` and `answers`.
      questions: request.toolInput.questions,
      answers,
    };
    if (Object.keys(annotations).length > 0) {
      updatedInput.annotations = annotations;
    }
    onSubmit(updatedInput);
  };

  // Render inline at the bottom of the chat, alongside PermissionCard. The
  // SDK gates AskUserQuestion through the same canUseTool channel as Bash
  // / Read / etc., but the right UX is "show the question with selectable
  // options" — and showing it inline (rather than as a modal Dialog) keeps
  // the surrounding chat context visible and means whichever tab raised
  // the prompt naturally surfaces it without any tab-switching trickery.

  if (questions.length === 0) {
    // Defensive: malformed input. Render the same inline shell so the user
    // can dismiss instead of being stuck on a permission prompt that has
    // nothing to allow.
    return (
      <div className="mx-2 my-2 rounded-lg border shadow-sm" style={accentStyle}>
        <div className="p-3 space-y-2">
          <div className="text-sm font-medium">Question from agent</div>
          <div className="text-xs text-muted-foreground">
            The agent invoked AskUserQuestion but the input had no parseable questions.
          </div>
          <div className="flex justify-end">
            <Button size="sm" variant="secondary" onClick={onCancel}>Dismiss</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-2 my-2 rounded-lg border shadow-sm" style={accentStyle}>
      {/* Outer column: header / scroll region / footer. Outer spacing is
          tighter (space-y-3) so the scroll boundary and the buttons sit
          close to the questions; the inner scroll region carries the wider
          space-y-4 between questions to match the prior layout. */}
      <div className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-start gap-2">
          <MessageCircleQuestion className="h-4 w-4 mt-0.5 shrink-0" style={{ color: accentSwatch }} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">The agent has a question for you</div>
            <div className="text-xs text-muted-foreground">
              {questions.length === 1
                ? 'Pick an option below — your selection is sent back to the agent.'
                : `Answer all ${questions.length} questions, then submit.`}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand question" : "Collapse question"}
            aria-expanded={!collapsed}
            className={cn(
              "shrink-0 -mt-0.5 -mr-0.5 h-6 w-6 inline-flex items-center justify-center rounded-md",
              "text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
          >
            {/* Match TodoBar / SubagentBar's chevron convention: expanded
                shows ChevronDown ("click to collapse downward"), collapsed
                shows ChevronUp ("click to expand upward"). The prior shape
                pointed the opposite way and was visually inconsistent with
                the two sibling bars in the same chat region. */}
            {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>

        {!collapsed && (
        <>
        {/* Questions — scrollable so the SDK's max-4 questions, each with
            up to 4 options + an optional preview block + the auto "Other"
            field, never blow past the chat layout. Cap at ~60% viewport
            height; pr-1 leaves room for the scrollbar. The Send / Cancel
            buttons stay pinned below this region so the user can always
            submit without scrolling back to the bottom. */}
        <div className="max-h-[60vh] overflow-y-auto pr-1 space-y-4">
        {questions.map((q, i) => {
          const sel = selections[i];
          const isOther = q.multiSelect
            ? Array.isArray(sel) && sel.includes(OTHER_VALUE)
            : sel === OTHER_VALUE;

          return (
            <div key={i} className="space-y-2">
              <div className="space-y-1">
                {q.header && (
                  <div className="inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                    {q.header}
                  </div>
                )}
                <div className="text-sm font-medium">{q.question}</div>
                {q.multiSelect && (
                  <div className="text-[11px] text-muted-foreground">
                    Multi-select — pick one or more.
                  </div>
                )}
              </div>
              <div className="grid gap-1.5">
                {q.options.map((opt) => {
                  const picked = q.multiSelect
                    ? Array.isArray(sel) && sel.includes(opt.label)
                    : sel === opt.label;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => togglePick(i, opt.label)}
                      className={cn(
                        "w-full text-left rounded-md border px-3 py-2 transition-colors",
                        "focus:outline-none focus:ring-1 focus:ring-ring",
                        picked
                          ? "border-foreground bg-foreground/5"
                          : "border-border hover:bg-muted/40",
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <div
                          className={cn(
                            "mt-0.5 h-3.5 w-3.5 shrink-0",
                            q.multiSelect ? "rounded-sm" : "rounded-full",
                            "border",
                            picked ? "bg-foreground border-foreground" : "border-muted-foreground/40",
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium">{opt.label}</div>
                          {opt.description && (
                            <div className="text-[11px] text-muted-foreground mt-0.5">
                              {opt.description}
                            </div>
                          )}
                          {opt.preview && (
                            <pre className="mt-1.5 text-[11px] font-mono whitespace-pre-wrap break-all rounded bg-muted/60 p-1.5 max-h-32 overflow-auto">
                              {opt.preview}
                            </pre>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
                {/* Auto-added "Other" — per SDK tool description, the host
                    appends this; the agent must not include it itself. */}
                <button
                  type="button"
                  onClick={() => togglePick(i, OTHER_VALUE)}
                  className={cn(
                    "w-full text-left rounded-md border border-dashed px-3 py-2 transition-colors",
                    "focus:outline-none focus:ring-1 focus:ring-ring",
                    isOther
                      ? "border-foreground bg-foreground/5"
                      : "border-border hover:bg-muted/40",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <div
                      className={cn(
                        "mt-0.5 h-3.5 w-3.5 shrink-0",
                        q.multiSelect ? "rounded-sm" : "rounded-full",
                        "border",
                        isOther ? "bg-foreground border-foreground" : "border-muted-foreground/40",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium">Other</div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        Type a custom answer.
                      </div>
                    </div>
                  </div>
                </button>
                {isOther && (
                  <input
                    type="text"
                    autoFocus
                    value={otherTexts[i]}
                    onChange={(e) => setOtherText(i, e.target.value)}
                    onKeyDown={(e) => {
                      // Enter mirrors the Send button — only fires when every
                      // question has a valid answer (same gate as the button's
                      // `disabled={!isComplete}`). Shift+Enter is reserved
                      // for newline-style intent (consistent with the chat
                      // composer's send-vs-newline split), and any modifier
                      // is treated as "not a submit shortcut."
                      if (e.key !== "Enter") return;
                      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
                      if (!isComplete) return;
                      e.preventDefault();
                      handleSubmit();
                    }}
                    placeholder="Your answer…"
                    className={cn(
                      "w-full h-8 px-2.5 rounded-md text-xs",
                      "bg-background border border-input",
                      "outline-none focus:ring-1 focus:ring-ring",
                    )}
                  />
                )}
              </div>
            </div>
          );
        })}
        </div>
        {/* /scroll region */}

        {/* Buttons */}
        <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/40">
          <Button size="sm" variant="ghost" className="text-xs" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="text-xs"
            onClick={handleSubmit}
            disabled={!isComplete}
          >
            <Send className="h-3.5 w-3.5 mr-1" />
            Send answer{questions.length > 1 ? 's' : ''}
          </Button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
