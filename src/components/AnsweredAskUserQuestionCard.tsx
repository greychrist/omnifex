import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { accentStyleFor, swatchFor } from '@/lib/accentStyle';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import { KindHeader } from '@/components/KindHeader';
import { Card, CardContent } from '@/components/ui/card';
import { IconRenderer } from '@/components/settings-panels/appearance/iconMap';
import { iconNameFor } from '@/lib/kindPresentation';
import {
  iconSizeClassName,
  iconWrapperClassName,
  iconWrapperStyle,
} from '@/lib/typographyClasses';

/**
 * Historical view of an answered `AskUserQuestion` interaction. Renders the
 * questions the agent asked alongside the user's picks as a single compact
 * card in the chat feed, so scrollback shows "agent asked X → user picked Y"
 * as one self-contained unit rather than a generic tool_use followed by a
 * blob of JSON-shaped tool_result.
 *
 * Sourced from the persistent stream:
 *   - `questions`  ← `tool_use.input.questions` (agent's original payload)
 *   - `answers`    ← `tool_result.content` JSON parsed to `{ answers, annotations? }`
 *
 * Compact layout, one row per question:
 *   ⬢  [Header]  Question text  →  Answer
 *                  You typed: "free text"   ← only when the user picked Other
 *
 * The "You typed:" sub-line surfaces the Other-text annotation that
 * `AskUserQuestionCard.handleSubmit` adds to the tool result — the agent
 * sees that annotation in its turn, so the chat record should too.
 */

interface OptionShape {
  label: string;
  description?: string;
  preview?: string;
}

interface QuestionShape {
  question: string;
  header?: string;
  options: OptionShape[];
  multiSelect?: boolean;
}

interface AnsweredAskUserQuestionCardProps {
  /** `input` from the assistant's `tool_use` block. */
  input: unknown;
  /** Stringified content of the matching `tool_result` block (the runtime
   *  always serialises it via JSON.stringify). May be undefined if the
   *  result hasn't landed yet — in that case the card renders just the
   *  questions with the picks blank, matching the "live awaiting" state. */
  resultContent?: string;
}

interface ParsedAnswerPayload {
  answers: Record<string, string>;
  annotations?: Record<string, { notes?: string }>;
}

/**
 * Pull `{ answers, annotations }` out of a tool_result body. The SDK/CLI
 * does NOT pass our structured `{ questions, answers, annotations }` payload
 * through to the model as JSON — it synthesises a human-readable string:
 *
 *   `User has answered your questions: "Q1"="A1", "Q2"="A2, A3" user notes: User selected Other: "<typed>". You can now continue with the user's answers in mind.`
 *
 * We anchor on each question's literal text from the tool_use input to
 * extract the answer, then scan the trailing `user notes:` section for
 * `User selected Other: "<text>"` patterns. When an Other-text equals a
 * question's answer (always true today, because `handleSubmit` swaps the
 * OTHER_VALUE sentinel for the typed text before sending), that question
 * gets the corresponding annotation back.
 *
 * Two non-wire shapes are still tolerated for tests and any future SDK
 * change that pipes the structured payload through:
 *   - JSON-stringified object (`{ answers, annotations }`)
 *   - Already-parsed object with that shape
 *   - Anthropic content-block array carrying either of the above
 */
function parseAnswerPayload(
  raw: unknown,
  questions: QuestionShape[],
): ParsedAnswerPayload | null {
  if (raw == null) return null;

  // Already-parsed object path (tests / replay paths).
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (obj.answers && typeof obj.answers === 'object') {
      return {
        answers: obj.answers as Record<string, string>,
        annotations:
          obj.annotations && typeof obj.annotations === 'object'
            ? (obj.annotations as Record<string, { notes?: string }>)
            : undefined,
      };
    }
  }

  // Anthropic content-block array — concatenate text children and recurse.
  if (Array.isArray(raw)) {
    const joined = raw
      .map((b: unknown) =>
        b && typeof b === 'object' && (b as { type?: string }).type === 'text'
          ? String((b as { text?: unknown }).text ?? '')
          : '',
      )
      .join('');
    if (joined.length === 0) return null;
    return parseAnswerPayload(joined, questions);
  }

  if (typeof raw !== 'string') return null;
  const text = raw;

  // First try JSON — covers the structured-payload path if a future SDK
  // change starts shipping the raw `updatedInput` through.
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && (parsed as { answers?: unknown }).answers) {
      return parseAnswerPayload(parsed, questions);
    }
  } catch {
    /* fall through to synthesised-string parsing */
  }

  // Synthesised-string path. Anchor on each question's literal text rather
  // than a generic `"key"="value"` regex — question text can contain
  // characters that would make a generic regex ambiguous (the answer text
  // can contain `, ` from multi-select joins, periods from prose, etc.).
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const qText = q.question;
    const escaped = qText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Lookahead boundaries (in order of likelihood):
    //   `", "` — another question follows
    //   `" user notes:` — annotations section follows
    //   ` You can now …` — end of payload (period optional: the live
    //                       format has a `.` only when notes precede it,
    //                       since the period belongs to the notes' own
    //                       terminator, not the trailer itself)
    //   end of string — fallback for truncated content
    const re = new RegExp(
      `"${escaped}"="([\\s\\S]*?)"(?=, "|\\s+user notes:|\\.?\\s*You can now|$)`,
    );
    const m = text.match(re);
    if (m) answers[qText] = m[1];
  }

  if (Object.keys(answers).length === 0) {
    // Couldn't anchor any question — the string isn't our expected wire
    // format. Return null so the card renders the "(no answer recorded)"
    // placeholders rather than misleading partial data.
    return null;
  }

  // Annotations: scan the notes section for `User selected Other: "<text>"`
  // mentions and pair them with whichever question's answer matches. The
  // wire format doesn't include a per-question key in the notes (the SDK
  // aggregates them into one trailing sentence), so matching by answer
  // text is the only honest mapping back.
  const annotations: Record<string, { notes?: string }> = {};
  const notesMatch = text.match(/user notes:\s*([\s\S]*?)(?:\.\s*You can now continue|$)/);
  if (notesMatch) {
    const notes = notesMatch[1];
    const otherTexts: string[] = Array.from(
      notes.matchAll(/User selected Other:\s*"([\s\S]*?)"/g),
    ).map((m) => m[1]);
    for (const [question, answer] of Object.entries(answers)) {
      if (otherTexts.some((t) => t === answer)) {
        annotations[question] = { notes: `User selected Other: "${answer}"` };
      }
    }
  }

  return {
    answers,
    annotations: Object.keys(annotations).length > 0 ? annotations : undefined,
  };
}

function parseQuestions(input: unknown): QuestionShape[] {
  if (!input || typeof input !== 'object') return [];
  const raw = (input as { questions?: unknown }).questions;
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

/**
 * Pull the typed Other text out of an annotation note. `AskUserQuestionCard`
 * encodes it as `User selected Other: "<text>"` so the tail end of the
 * stream record exposes the free-text answer. The regex stays loose enough
 * to tolerate quote-mark variations the user might paste.
 */
function extractOtherText(note: string | undefined): string | null {
  if (!note) return null;
  const m = note.match(/User selected Other:\s*["“”]?(.*?)["“”]?$/);
  if (!m) return null;
  const text = m[1].trim();
  return text.length > 0 ? text : null;
}

const KIND_ID = 'tool.askUserQuestion.answered';

export function AnsweredAskUserQuestionCard({
  input,
  resultContent,
}: AnsweredAskUserQuestionCardProps) {
  const { config } = useMessageRenderingConfig();
  const accentStyle = accentStyleFor(config, KIND_ID);
  const accentSwatch = swatchFor(config, KIND_ID);
  const iconName = iconNameFor(config, KIND_ID);

  const questions = useMemo(() => parseQuestions(input), [input]);
  const payload = useMemo(
    () => parseAnswerPayload(resultContent, questions),
    [resultContent, questions],
  );

  if (questions.length === 0) return null;

  // First-order response template — same outer chrome the assistant card
  // uses in `StreamMessage.tsx` (Card + flex justify-start + 95% width +
  // avatar icon column + body column with KindHeader). Routing every
  // visual concern through the shared MessageRenderingConfig means a
  // user's Appearance edits for this kind (label, icon, iconSize,
  // iconBordered, accent) take effect with no per-card wiring.
  return (
    <div className="flex justify-start" data-testid="answered-ask-user-question-card">
      <Card className="border w-[95%] relative" style={accentStyle}>
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            {/* Avatar icon — honours kind's icon name, iconSize, and
                iconBordered config. Same pattern as the assistant card's
                bot avatar. */}
            <div
              className={iconWrapperClassName(config, KIND_ID)}
              style={iconWrapperStyle(config, accentSwatch, KIND_ID)}
            >
              <IconRenderer
                name={iconName && iconName !== 'none' ? iconName : 'CircleHelp'}
                className={iconSizeClassName(config, KIND_ID)}
              />
            </div>
            <div className="flex-1 space-y-2 min-w-0 overflow-x-auto">
              {/* Label-only KindHeader — `showIcon` is omitted because
                  the avatar above is the icon. A user-set `headerLabel`
                  in Settings → Chats wins; otherwise the dynamic
                  singular/plural fallback applies. */}
              <KindHeader
                kindId={KIND_ID}
                fallbackLabel={
                  questions.length === 1
                    ? 'Question answered'
                    : `${questions.length} questions answered`
                }
              />
              {/* Three-column subgrid: headers / questions / answers all
                  align vertically across rows. Each question is its own
                  subgrid so the parent's column tracks govern alignment
                  without auto-placement collisions. Columns:
                    1. auto              — header label (widest wins)
                    2. minmax(0, 1fr)    — question text
                    3. minmax(0, 1.5fr)  — answer (italic; slightly wider
                                           than the question column so
                                           multi-word Other-text answers
                                           breathe)
                  For Other answers the answer cell renders
                  `You typed: "<text>"` directly. */}
              <div
                className={cn(
                  'grid items-baseline gap-x-3 gap-y-1.5',
                  'grid-cols-[auto_minmax(0,1fr)_minmax(0,1.5fr)]',
                  'text-xs leading-snug',
                )}
              >
                {questions.map((q, i) => {
                  const answer = payload?.answers?.[q.question];
                  const note = payload?.annotations?.[q.question]?.notes;
                  const otherText = extractOtherText(note);
                  const hasAnswer = answer != null && answer.length > 0;
                  return (
                    <div
                      key={i}
                      className="grid grid-cols-subgrid col-span-3 items-baseline gap-x-3"
                    >
                      {/* Header label — accent-coloured, no background.
                          Always emit the cell (empty if absent) so the
                          column-1 alignment is preserved across rows. */}
                      <div className="flex items-baseline">
                        {q.header && (
                          <span
                            className="text-[10px] uppercase tracking-wide font-semibold"
                            style={{ color: accentSwatch }}
                          >
                            {q.header}
                          </span>
                        )}
                      </div>
                      <span className="text-foreground/80 break-words">{q.question}</span>
                      {/* Answer rendered as an opaque pill so the
                          assistant-card colour beneath the translucent
                          accent doesn't bleed through. `inline-block`
                          keeps the pill sized to its content and lets
                          long answers wrap as one cohesive block. */}
                      <span
                        className={cn(
                          'inline-block italic text-foreground break-words',
                          'rounded-md bg-background px-2 py-0.5',
                        )}
                      >
                        {otherText
                          ? <>You typed: “{otherText}”</>
                          : hasAnswer
                            ? answer
                            : '(no answer recorded)'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
