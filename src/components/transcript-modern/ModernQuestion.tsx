/**
 * AskUserQuestion in the Modern format — AI Elements' Questionnaire.
 *
 * `ModernQuestionCard` is the live card (answers go back through the same
 * `buildAskUserQuestionAnswer` the classic card uses); `AnsweredQuestion` is
 * the transcript's record of what was picked.
 */
import * as React from 'react';
import { Check, ChevronDown, ChevronUp, MessageCircleQuestion, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { JsonlNode } from '@/types/jsonl';
import type { PermissionRequestPayload } from '@/lib/types/permissionRequest';
import { buildAskUserQuestionAnswer, OTHER_VALUE } from '@/lib/askUserQuestionAnswer';
import { parseAnswerPayload, parseQuestions, type QuestionShape } from '@/components/AnsweredAskUserQuestionCard';

function OptionRow({
  multi,
  on,
  label,
  description,
  onClick,
  readOnly,
}: {
  multi: boolean;
  on: boolean;
  label: string;
  description?: string;
  onClick?: () => void;
  readOnly?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={readOnly}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-default',
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
  collapsible = false,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** The live card folds to its header, as the classic card does, so the
   *  chat behind a tall question can be read before answering. */
  collapsible?: boolean;
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  return (
    <div className="modern-format w-full overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className={cn('flex items-center gap-2 px-4 py-3 text-sm', !collapsed && 'border-b')}>
        <MessageCircleQuestion className="size-4 text-muted-foreground" />
        <span className="flex-1 font-medium">{title}</span>
        {collapsible && (
          <button
            type="button"
            onClick={() => { setCollapsed((c) => !c); }}
            aria-label={collapsed ? 'Expand question' : 'Collapse question'}
            aria-expanded={!collapsed}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
        )}
      </div>
      {!collapsed && (
        <>
          <div className="max-h-[60vh] space-y-5 overflow-y-auto p-4">{children}</div>
          {footer && <div className="flex items-center justify-between gap-2 border-t px-4 py-3">{footer}</div>}
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
      collapsible
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

/** The structured answers the CLI keeps on the result record, if present. */
function structuredAnswers(resultNode: JsonlNode | undefined): Record<string, string> | null {
  const tur = (resultNode as { raw?: { toolUseResult?: { answers?: unknown } } } | undefined)?.raw?.toolUseResult;
  const a = tur?.answers;
  return a && typeof a === 'object' ? (a as Record<string, string>) : null;
}

function resultContent(resultNode: JsonlNode | undefined): unknown {
  const content = (resultNode as { raw?: { message?: { content?: unknown } } } | undefined)?.raw?.message?.content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find((b) => (b as { type?: string }).type === 'tool_result') as { content?: unknown } | undefined;
  return block?.content;
}

export function AnsweredQuestion({ input, resultNode }: { input: Record<string, unknown>; resultNode?: JsonlNode }) {
  const questions = React.useMemo(() => parseQuestions(input), [input]);
  const answers = React.useMemo(
    () => structuredAnswers(resultNode) ?? parseAnswerPayload(resultContent(resultNode), questions)?.answers ?? null,
    [resultNode, questions],
  );
  return (
    <Shell title={answers ? 'You answered' : 'Waiting for your answer'}>
      {questions.map((q) => {
        const answer = answers?.[q.question];
        const picks = answer ? answer.split(', ') : [];
        const known = new Set(q.options.map((o) => o.label));
        const typed = picks.filter((p) => !known.has(p));
        return (
          <div key={q.question} className="space-y-3">
            <QuestionHead q={q} />
            <div className="grid gap-2">
              {q.options.filter((o) => !answers || picks.includes(o.label)).map((o) => (
                <OptionRow key={o.label} multi={q.multiSelect === true} on={picks.includes(o.label)} label={o.label} description={o.description} readOnly />
              ))}
              {typed.length > 0 && (
                <OptionRow multi={false} on label={typed.join(', ')} description="Typed answer" readOnly />
              )}
              {answers && picks.length === 0 && answer !== undefined && (
                <div className="text-sm text-muted-foreground">{answer || 'No answer'}</div>
              )}
            </div>
          </div>
        );
      })}
    </Shell>
  );
}
