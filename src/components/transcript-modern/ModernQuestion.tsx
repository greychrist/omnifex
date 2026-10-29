/**
 * AskUserQuestion in the Modern format — AI Elements' Questionnaire.
 *
 * The live card; answers go back through the same `buildAskUserQuestionAnswer`
 * the classic card uses. Once answered, the transcript draws the classic
 * `AnsweredAskUserQuestionCard` in both formats.
 */
import * as React from 'react';
import { Check, ChevronDown, ChevronUp, MessageCircleQuestion, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { accentStyleFor, cardRadiusStyle, swatchFor } from '@/lib/accentStyle';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import type { PermissionRequestPayload } from '@/lib/types/permissionRequest';
import { buildAskUserQuestionAnswer, OTHER_VALUE } from '@/lib/askUserQuestionAnswer';
import { parseQuestions, type QuestionShape } from '@/components/AnsweredAskUserQuestionCard';

function OptionRow({
  multi,
  on,
  label,
  description,
  onClick,
}: {
  multi: boolean;
  on: boolean;
  label: string;
  description?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
        on ? 'border-primary/60 bg-primary/5' : 'hover:bg-accent/50',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
          multi ? 'rounded' : 'rounded-full',
          on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
        )}
      >
        {on && <Check className="size-3" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>}
      </span>
    </button>
  );
}

function QuestionHead({ q, hint }: { q: QuestionShape; hint?: string }) {
  return (
    <div className="space-y-1">
      {q.header && <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{q.header}</div>}
      <div className="text-sm font-medium">{q.question}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Shell({
  title,
  children,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  // Folds to its header, as the classic card does, so the chat behind a tall
  // question can be read before answering.
  const [collapsed, setCollapsed] = React.useState(false);
  // The classic card's per-kind accent (Settings → Chats) and inset margin, so
  // a waiting question stands out from the chat.
  const { config } = useMessageRenderingConfig();
  const accentStyle = { ...accentStyleFor(config, 'permission.askUserQuestion'), ...cardRadiusStyle(config) };
  const swatch = swatchFor(config, 'permission.askUserQuestion');
  return (
    <div className="modern-format mx-2 my-2 overflow-hidden rounded-xl border shadow-sm" style={accentStyle}>
      <div className={cn('flex items-center gap-2 px-4 py-3 text-sm', !collapsed && 'border-b')}>
        <MessageCircleQuestion className="size-4 text-muted-foreground" style={swatch ? { color: swatch } : undefined} />
        <span className="flex-1 font-medium">{title}</span>
        <button
          type="button"
          onClick={() => { setCollapsed((c) => !c); }}
          aria-label={collapsed ? 'Expand question' : 'Collapse question'}
          aria-expanded={!collapsed}
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="max-h-[60vh] space-y-5 overflow-y-auto p-4">{children}</div>
          <div className="flex items-center justify-between gap-2 border-t px-4 py-3">{footer}</div>
        </>
      )}
    </div>
  );
}

export function ModernQuestionCard({
  request,
  onSubmit,
  onCancel,
}: {
  request: PermissionRequestPayload;
  onSubmit: (updatedInput: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const questions = React.useMemo(() => parseQuestions(request.toolInput), [request.toolInput]);
  const [selections, setSelections] = React.useState<(string | string[] | null)[]>(
    () => questions.map((q) => (q.multiSelect ? [] : null)),
  );
  const [otherTexts, setOtherTexts] = React.useState<string[]>(() => questions.map(() => ''));

  const picked = (i: number, label: string) => {
    const sel = selections[i];
    return Array.isArray(sel) ? sel.includes(label) : sel === label;
  };
  const toggle = (i: number, label: string) => {
    setSelections((prev) => {
      const next = prev.slice();
      const cur = next[i];
      if (questions[i].multiSelect) {
        const list = Array.isArray(cur) ? cur : [];
        next[i] = list.includes(label) ? list.filter((l) => l !== label) : [...list, label];
      } else {
        next[i] = cur === label ? null : label;
      }
      return next;
    });
  };
  const complete = questions.length > 0 && questions.every((_q, i) => {
    const sel = selections[i];
    const picks = Array.isArray(sel) ? sel : sel ? [sel] : [];
    if (picks.length === 0) return false;
    return !picks.includes(OTHER_VALUE) || otherTexts[i].trim() !== '';
  });
  const submit = () => {
    if (complete) onSubmit(buildAskUserQuestionAnswer(request.toolInput.questions, questions, selections, otherTexts));
  };

  return (
    <Shell
      title="Claude has a question"
      footer={
        <>
          <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={onCancel}>Dismiss</Button>
          <Button size="sm" className="h-8" onClick={submit} disabled={!complete}>
            Send answer{questions.length > 1 ? 's' : ''}
          </Button>
        </>
      }
    >
      {questions.length === 0 && (
        <div className="text-sm text-muted-foreground">The question arrived with nothing to answer.</div>
      )}
      {questions.map((q, i) => (
        <div key={q.question} className="space-y-3">
          <QuestionHead q={q} hint={q.multiSelect ? 'Choose any that apply.' : undefined} />
          <div className="grid gap-2">
            {q.options.map((o) => (
              <OptionRow
                key={o.label}
                multi={q.multiSelect === true}
                on={picked(i, o.label)}
                label={o.label}
                description={o.description}
                onClick={() => { toggle(i, o.label); }}
              />
            ))}
            <label
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border border-dashed px-3 py-2 transition-colors',
                picked(i, OTHER_VALUE) ? 'border-primary/60 bg-primary/5' : 'hover:bg-accent/50',
              )}
            >
              <Pencil className="size-4 shrink-0 text-muted-foreground" />
              <input
                value={otherTexts[i]}
                placeholder="Something else…"
                aria-label={`Other answer to: ${q.question}`}
                className="h-6 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                onChange={(e) => {
                  const v = e.target.value;
                  setOtherTexts((prev) => { const next = prev.slice(); next[i] = v; return next; });
                  // Typing picks Other; clearing un-picks it.
                  if ((v.trim() !== '') !== picked(i, OTHER_VALUE)) toggle(i, OTHER_VALUE);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
            </label>
          </div>
        </div>
      ))}
    </Shell>
  );
}
