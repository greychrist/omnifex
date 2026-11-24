import * as React from 'react';
import { IconRenderer } from '@/components/settings-panels/appearance/iconMap';
import { extractOtherText, parseAnswerPayload, parseQuestions } from '@/lib/askUserQuestionParse';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import { resolveKind } from '@/lib/messageRenderingConfig';
import { Trace, TraceIcon, TraceLine, TraceTitle } from './trace';

const KIND_ID = 'assistant.askUserQuestion';

export function QuestionLine({ input, resultContent }: { input: unknown; resultContent?: string }) {
  const { config } = useMessageRenderingConfig();
  const kind = resolveKind(config, KIND_ID);
  const questions = React.useMemo(() => parseQuestions(input), [input]);
  const payload = React.useMemo(() => parseAnswerPayload(resultContent, questions), [resultContent, questions]);
  if (questions.length === 0) return null;
  return (
    <Trace data-question-line>
      <TraceLine>
        <TraceIcon style={{ color: kind.accentColor }}><IconRenderer name={kind.icon} /></TraceIcon>
        <TraceTitle style={{ color: kind.accentColor }}>{questions.length === 1 ? 'Question answered' : `${questions.length} questions answered`}</TraceTitle>
      </TraceLine>
      {/* Inline rule: the unlayered `* { border-color }` reset beats border-color utilities. */}
      <div data-question-body className="ml-[7px] min-w-0 space-y-2 pr-1 pl-4 text-sm leading-relaxed break-words" style={{ borderLeft: `0.5px solid ${kind.accentColor}` }}>
        {questions.map((q, i) => {
          const answer = payload?.answers?.[q.question];
          const other = extractOtherText(payload?.annotations?.[q.question]?.notes);
          return (
            <div key={i} className="min-w-0">
              <div className="text-muted-foreground">
                {q.header && <span className="mr-2 text-xs font-medium uppercase tracking-wide">{q.header}</span>}
                <span className="underline underline-offset-2">{q.question}</span>
              </div>
              <div className="text-foreground">
                {other ? `Other: ${other}` : answer ? answer : <span className="text-muted-foreground italic">No answer recorded</span>}
              </div>
            </div>
          );
        })}
      </div>
    </Trace>
  );
}
