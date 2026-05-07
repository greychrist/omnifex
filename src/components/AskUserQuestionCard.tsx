import { useMemo, useState } from "react";
import { Send, MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { swatchFor } from "@/lib/accentStyle";
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
  // Pull just the swatch — the dialog's background MUST stay opaque
  // (`bg-background` on DialogContent), so the translucent accent bg
  // returned by `accentStyleFor` is not applied here. The swatch becomes
  // the 4px left stripe and the question icon color so per-kind theming
  // (Settings → Chats) still reads.
  const accentSwatch = swatchFor(config, 'permission.askUserQuestion');

  const questions = useMemo(() => parseQuestions(request.toolInput), [request.toolInput]);

  // selections[i]: for single-select → string | null. for multi-select → string[].
  // For both modes the special value `OTHER_VALUE` means "user picked Other"
  // and the actual text lives in `otherTexts[i]`.
  const [selections, setSelections] = useState<Array<string | string[] | null>>(
    () => questions.map((q) => (q.multiSelect ? [] : null)),
  );
  const [otherTexts, setOtherTexts] = useState<string[]>(() => questions.map(() => ''));

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

  // Render as a modal Dialog so the card overlays the chat instead of
  // pushing it up. The Dialog portals to <body>, so the surrounding
  // `shrink-0` container in ClaudeCodeSession doesn't reserve vertical
  // space for it. Escape / backdrop click / the built-in X all funnel
  // through onOpenChange → onCancel, which sends `behavior: 'deny'` and
  // dismisses cleanly.
  const handleOpenChange = (open: boolean) => {
    if (!open) onCancel();
  };

  if (questions.length === 0) {
    // Defensive: malformed input. Show the same dialog frame so the user
    // can dismiss instead of being stuck on a permission prompt that has
    // nothing to allow.
    return (
      <Dialog open onOpenChange={handleOpenChange}>
        <DialogContent
          className="max-w-md p-4 border-l-4 bg-background"
          style={{ borderLeftColor: accentSwatch }}
        >
          <div className="text-sm font-medium">Question from agent</div>
          <div className="text-xs text-muted-foreground mt-1">
            The agent invoked AskUserQuestion but the input had no parseable questions.
          </div>
          <div className="mt-3 flex justify-end">
            <Button size="sm" variant="secondary" onClick={onCancel}>Dismiss</Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      {/* max-w-2xl gives multi-question stacks room without going full-width
          on large displays. Background stays fully opaque (`bg-background`)
          — DO NOT spread `accentStyle` here; its translucent
          `backgroundColor: <swatch>14` would override bg-background and
          make the dialog see-through. The accent color shows up as the 4px
          left stripe; the swatch is also reused for the question icon. */}
      <DialogContent
        className="max-w-2xl p-0 border-l-4 overflow-hidden bg-background"
        style={{ borderLeftColor: accentSwatch }}
      >
      {/* Outer column: header / scroll region / footer. Outer spacing is
          tighter (space-y-3) so the scroll boundary and the buttons sit
          close to the questions; the inner scroll region carries the wider
          space-y-4 between questions to match the prior layout. */}
      <div className="p-4 space-y-3">
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
        </div>

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
      </div>
      </DialogContent>
    </Dialog>
  );
}
