/**
 * The CLI's `AskUserQuestionOutput` shape. "Other" is the host's own option (the agent must not offer it);
 * its typed text replaces the sentinel and is noted.
 */
export const OTHER_VALUE = '__omnifex_other__';

export function buildAskUserQuestionAnswer(
  rawQuestions: unknown,
  questions: { question: string; multiSelect?: boolean }[],
  selections: (string | string[] | null)[],
  otherTexts: string[],
): Record<string, unknown> {
  const answers: Record<string, string> = {};
  const annotations: Record<string, { notes?: string }> = {};
  questions.forEach((q, i) => {
    const sel = selections[i];
    const otherText = (otherTexts[i] ?? '').trim();
    const picksRaw = q.multiSelect
      ? (Array.isArray(sel) ? sel : [])
      : (typeof sel === 'string' ? [sel] : []);
    const picks = picksRaw.map((p) => (p === OTHER_VALUE ? otherText : p)).filter(Boolean);
    answers[q.question] = picks.join(', ');
    if (picksRaw.includes(OTHER_VALUE)) {
      annotations[q.question] = { notes: `User selected Other: "${otherText}"` };
    }
  });
  const updatedInput: Record<string, unknown> = { questions: rawQuestions, answers };
  if (Object.keys(annotations).length > 0) updatedInput.annotations = annotations;
  return updatedInput;
}
