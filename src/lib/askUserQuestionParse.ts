/**
 * Reading an answered AskUserQuestion: the questions from the tool call's
 * input, and the answers from the CLI's tool result. The result string
 * drifts between CLI releases (prefix, notes delimiter, trailer), so the
 * parser anchors on each question's literal text — see the wire-format tests
 * in QuestionLine.test.tsx. Moved out of the classic answered-question card
 * when that renderer was deleted (2026-11-18).
 */
interface OptionShape {
  label: string;
  description?: string;
  preview?: string;
}

export interface QuestionShape {
  question: string;
  header?: string;
  options: OptionShape[];
  multiSelect?: boolean;
}

interface ParsedAnswerPayload {
  answers: Record<string, string>;
  annotations?: Record<string, { notes?: string }>;
}

/**
 * Pull `{ answers, annotations }` out of a tool_result body. The CLI
 * does NOT pass our structured `{ questions, answers, annotations }` payload
 * through to the model as JSON — it synthesises a human-readable string:
 *
 *   `Your questions have been answered: "Q1"="A1", "Q2"="A2, A3" notes: User selected Other: "<typed>". You can now continue with these answers in mind.`
 *
 * Every part of that sentence except the `"question"="answer"` pairs has
 * drifted between CLI builds: the prefix ("User has answered your questions:"
 * → "Your questions have been answered:" → "The user answered:"), the
 * annotation delimiter (`user notes:` → `notes:`), and the trailer ("You can
 * now continue with these answers in mind." → "Read the answers carefully —
 * …"). So we anchor only on each question's literal text from the tool_use
 * input and slice answers out by index; no prefix or trailer wording is
 * matched, and the `user ` on the delimiter stays optional.
 *
 * Having extracted the answers, we scan the trailing `notes:` section for
 * `User selected Other: "<text>"` patterns. When an Other-text equals a
 * question's answer (always true today, because `handleSubmit` swaps the
 * OTHER_VALUE sentinel for the typed text before sending), that question
 * gets the corresponding annotation back.
 *
 * Two non-wire shapes are still tolerated for tests and any future CLI
 * change that pipes the structured payload through:
 *   - JSON-stringified object (`{ answers, annotations }`)
 *   - Already-parsed object with that shape
 *   - Anthropic content-block array carrying either of the above
 */
export function parseAnswerPayload(
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
          // eslint-disable-next-line @typescript-eslint/no-base-to-string -- caller controls input; falls back to JSON.stringify upstream.
          ? String((b as { text?: unknown }).text ?? '')
          : '',
      )
      .join('');
    if (joined.length === 0) return null;
    return parseAnswerPayload(joined, questions);
  }

  if (typeof raw !== 'string') return null;
  const text = raw;

  // First try JSON — covers the structured-payload path if a future CLI
  // change starts shipping the raw `updatedInput` through.
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && (parsed as { answers?: unknown }).answers) {
      return parseAnswerPayload(parsed, questions);
    }
  } catch {
    /* fall through to synthesised-string parsing */
  }

  // Synthesised-string path. Locate each question's literal `"<q>"="` anchor
  // and slice the answer out by index, rather than matching against a
  // terminator pattern. The trailing prose is the part of this format that
  // keeps drifting — "You can now continue with these answers in mind." became
  // "Read the answers carefully — …" — and it was only ever load-bearing for
  // the *last* question, which is exactly the one that silently rendered
  // "(no answer recorded)" (session cd8cb2a5). Index slicing drops the
  // dependency on trailer wording entirely:
  //   - a non-final answer ends where the next question's anchor starts
  //   - the final answer ends at the last `"` before the notes section, or
  //     before end of string — trailers never contain quotes
  // It also removes the regex-escaping hazard: question text is compared
  // literally, so `{from, input, output}` and friends need no escaping.
  const anchors: { question: string; anchorStart: number; valueStart: number }[] = [];
  let cursor = 0;
  for (const q of questions) {
    const needle = `"${q.question}"="`;
    const at = text.indexOf(needle, cursor);
    // Not found → that question has no answer in this payload. Leave it out
    // so the card shows "(no answer recorded)" for it and only it.
    if (at === -1) continue;
    anchors.push({ question: q.question, anchorStart: at, valueStart: at + needle.length });
    cursor = at + needle.length;
  }

  // `notes:` is the annotation delimiter only where it follows the final
  // answer; the same characters inside an earlier answer are answer content.
  const lastValueStart = anchors.length > 0 ? anchors[anchors.length - 1].valueStart : 0;
  const notesRe = /\s+(?:user )?notes:/g;
  notesRe.lastIndex = lastValueStart;
  const notesHit = notesRe.exec(text);
  const answersEnd = notesHit ? notesHit.index : text.length;

  const answers: Record<string, string> = {};
  for (let i = 0; i < anchors.length; i++) {
    const { question, valueStart } = anchors[i];
    const next = anchors[i + 1];
    // Non-final: `A", ` up to the next anchor — strip the separator, then the
    // closing quote. Final: everything up to the notes section (or the end),
    // cut at its last quote so the trailer prose falls away.
    const segment = next
      ? text.slice(valueStart, next.anchorStart).replace(/\s*,\s*$/, '')
      : text.slice(valueStart, answersEnd);
    const close = segment.lastIndexOf('"');
    // No closing quote → truncated payload. Record nothing rather than a
    // half-answer.
    if (close === -1) continue;
    answers[question] = segment.slice(0, close);
  }

  if (Object.keys(answers).length === 0) {
    // Couldn't anchor any question — the string isn't our expected wire
    // format. Return null so the card renders the "(no answer recorded)"
    // placeholders rather than misleading partial data.
    return null;
  }

  // Annotations: scan the notes section for `User selected Other: "<text>"`
  // mentions and pair them with whichever question's answer matches. The
  // wire format doesn't include a per-question key in the notes (the CLI
  // aggregates them into one trailing sentence), so matching by answer
  // text is the only honest mapping back.
  const annotations: Record<string, { notes?: string }> = {};
  if (notesHit) {
    const notes = text.slice(notesHit.index + notesHit[0].length);
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

export function parseQuestions(input: unknown): QuestionShape[] {
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
export function extractOtherText(note: string | undefined): string | null {
  if (!note) return null;
  const m = /User selected Other:\s*["“”]?(.*?)["“”]?$/.exec(note);
  if (!m) return null;
  const text = m[1].trim();
  return text.length > 0 ? text : null;
}
