// The CLI's answer string drifts between releases: anchor only on each question's literal text.
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
 * The CLI synthesizes prose, not JSON: `... "Q1"="A1", "Q2"="A2" notes: User selected Other: "<typed>". ...`.
 * Only the `"question"="answer"` pairs are stable; prefix, delimiter and trailer all drift.
 */
export function parseAnswerPayload(
  raw: unknown,
  questions: QuestionShape[],
): ParsedAnswerPayload | null {
  if (raw == null) return null;

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

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && (parsed as { answers?: unknown }).answers) {
      return parseAnswerPayload(parsed, questions);
    }
  } catch {
    /* fall through to synthesised-string parsing */
  }

  // Slice by anchor index, never by trailer wording: a non-final answer ends at the next anchor, the final at its last quote.
  const anchors: { question: string; anchorStart: number; valueStart: number }[] = [];
  let cursor = 0;
  for (const q of questions) {
    const needle = `"${q.question}"="`;
    const at = text.indexOf(needle, cursor);
    if (at === -1) continue;
    anchors.push({ question: q.question, anchorStart: at, valueStart: at + needle.length });
    cursor = at + needle.length;
  }

  // `notes:` delimits only after the final answer; earlier it is answer content.
  const lastValueStart = anchors.length > 0 ? anchors[anchors.length - 1].valueStart : 0;
  const notesRe = /\s+(?:user )?notes:/g;
  notesRe.lastIndex = lastValueStart;
  const notesHit = notesRe.exec(text);
  const answersEnd = notesHit ? notesHit.index : text.length;

  const answers: Record<string, string> = {};
  for (let i = 0; i < anchors.length; i++) {
    const { question, valueStart } = anchors[i];
    const next = anchors[i + 1];
    const segment = next
      ? text.slice(valueStart, next.anchorStart).replace(/\s*,\s*$/, '')
      : text.slice(valueStart, answersEnd);
    const close = segment.lastIndexOf('"');
    if (close === -1) continue;
    answers[question] = segment.slice(0, close);
  }

  if (Object.keys(answers).length === 0) {
    return null;
  }

  // Notes carry no per-question key, so Other-text pairs back by answer text.
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

export function extractOtherText(note: string | undefined): string | null {
  if (!note) return null;
  const m = /User selected Other:\s*["“”]?(.*?)["“”]?$/.exec(note);
  if (!m) return null;
  const text = m[1].trim();
  return text.length > 0 ? text : null;
}
