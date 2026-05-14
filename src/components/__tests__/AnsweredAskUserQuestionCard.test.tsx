// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { AnsweredAskUserQuestionCard } from '../AnsweredAskUserQuestionCard';

afterEach(() => { cleanup(); });

// Mirrors the SDK shape `AskUserQuestionCard.handleSubmit` produces — keep
// these factories close to that so a wire-format drift breaks here first.
function input(questions: { question: string; header?: string; options?: { label: string }[]; multiSelect?: boolean }[]) {
  return {
    questions: questions.map((q) => ({
      question: q.question,
      header: q.header,
      options: q.options ?? [],
      multiSelect: q.multiSelect ?? false,
    })),
  };
}

/**
 * Build the synthesised wire-format string the SDK/CLI actually returns
 * to the renderer. Verified against live session
 * `d6ac42ec-47c0-47ef-8b4b-81fda02fa2f5`. The original assumption was
 * that we'd see our structured `{ answers, annotations }` as JSON — the
 * SDK rewrites it to a human-readable sentence the model can consume.
 */
function resultWire(
  answers: Record<string, string>,
  others?: string[],
): string {
  const pairs = Object.entries(answers)
    .map(([q, a]) => `"${q}"="${a}"`)
    .join(', ');
  const notes = others && others.length > 0
    ? ` user notes: ${others.map((t) => `User selected Other: "${t}"`).join('. ')}.`
    : '';
  return `User has answered your questions: ${pairs}${notes} You can now continue with the user's answers in mind.`;
}

/**
 * The legacy JSON shape — retained for the fallback path and any future
 * SDK release that pipes the structured payload through unchanged.
 */
function resultJson(answers: Record<string, string>, annotations?: Record<string, { notes?: string }>) {
  return JSON.stringify({ answers, annotations });
}

describe('AnsweredAskUserQuestionCard (wire format — synthesised string)', () => {
  it('renders one row per question with the header chip, question text, and answer', () => {
    render(
      <AnsweredAskUserQuestionCard
        input={input([{ question: 'Pick a color', header: 'Color', options: [{ label: 'Red' }] }])}
        resultContent={resultWire({ 'Pick a color': 'Red' })}
      />,
    );

    const card = screen.getByTestId('answered-ask-user-question-card');
    expect(within(card).getByText('Color')).toBeTruthy();
    expect(within(card).getByText('Pick a color')).toBeTruthy();
    expect(within(card).getByText('Red')).toBeTruthy();
  });

  it('renders the singular header for a single-question call', () => {
    render(
      <AnsweredAskUserQuestionCard
        input={input([{ question: 'A?', options: [{ label: 'B' }] }])}
        resultContent={resultWire({ 'A?': 'B' })}
      />,
    );
    expect(screen.getByText('Question answered')).toBeTruthy();
  });

  it('renders the count header for multi-question calls', () => {
    render(
      <AnsweredAskUserQuestionCard
        input={input([
          { question: 'A?', options: [{ label: 'X' }] },
          { question: 'B?', options: [{ label: 'Y' }] },
          { question: 'C?', options: [{ label: 'Z' }] },
        ])}
        resultContent={resultWire({ 'A?': 'X', 'B?': 'Y', 'C?': 'Z' })}
      />,
    );
    expect(screen.getByText('3 questions answered')).toBeTruthy();
  });

  it('shows the comma-joined picks for a multi-select answer', () => {
    // The live submit path joins multi-select picks with ', ' before sending
    // to the SDK; the synthesised wire string preserves that joined value
    // verbatim inside the `"q"="A, B"` slot. Our parser anchors on the
    // question's literal text and captures up to the next boundary, so the
    // ', ' inside the answer doesn't fool it into stopping early.
    render(
      <AnsweredAskUserQuestionCard
        input={input([{ question: 'Pick toppings', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }])}
        resultContent={resultWire({ 'Pick toppings': 'A, B' })}
      />,
    );
    expect(screen.getByText('A, B')).toBeTruthy();
  });

  it('shows the italic "You typed:" form when the user selected Other (and only that form)', () => {
    render(
      <AnsweredAskUserQuestionCard
        input={input([{ question: 'Pick', options: [{ label: 'X' }] }])}
        resultContent={resultWire({ Pick: 'Magenta' }, ['Magenta'])}
      />,
    );
    // The italic line renders the typed text with curly quotes.
    expect(screen.getByText(/You typed:.*Magenta/)).toBeTruthy();
    // And the raw text "Magenta" doesn't render a second time outside the
    // "You typed:" line — the answer column shows the typed form
    // exclusively for Other answers (no duplication).
    expect(screen.getAllByText(/Magenta/).length).toBe(1);
  });

  it('omits the "You typed:" sub-line when there is no annotation', () => {
    render(
      <AnsweredAskUserQuestionCard
        input={input([{ question: 'Pick', options: [{ label: 'X' }] }])}
        resultContent={resultWire({ Pick: 'X' })}
      />,
    );
    expect(screen.queryByText(/You typed:/)).toBeNull();
  });

  it('parses the live session d6ac42ec-47c0-47ef-8b4b-81fda02fa2f5 verbatim', () => {
    // Frozen against the actual JSONL content from the bug-report screenshot.
    // If the wire format changes, this test breaks first and points at the
    // specific session that proves the regression.
    const liveContent =
      'User has answered your questions: ' +
      '"Which color do you prefer?"="Blue", ' +
      '"Which programming languages do you use regularly?"="TypeScript, Python", ' +
      '"How should I proceed with verification by default?"="This is a test, custom, answer.  I want to see how it looks, especially when it\'s longer.  Hopefully it will look nice."' +
      ' user notes: User selected Other: "This is a test, custom, answer.  I want to see how it looks, especially when it\'s longer.  Hopefully it will look nice."' +
      '. You can now continue with the user\'s answers in mind.';

    render(
      <AnsweredAskUserQuestionCard
        input={input([
          { question: 'Which color do you prefer?', header: 'Color', options: [{ label: 'Blue' }, { label: 'Red' }, { label: 'Green' }] },
          { question: 'Which programming languages do you use regularly?', header: 'Languages', options: [{ label: 'TypeScript' }, { label: 'Python' }, { label: 'Rust' }, { label: 'Go' }], multiSelect: true },
          { question: 'How should I proceed with verification by default?', header: 'Verify mode', options: [{ label: 'Run npm run check only (Recommended)' }] },
        ])}
        resultContent={liveContent}
      />,
    );

    // Each answer rendered against its question — no "(no answer recorded)"
    // anywhere, which was the symptom of the bug.
    expect(screen.queryByText('(no answer recorded)')).toBeNull();
    expect(screen.getByText('Blue')).toBeTruthy();
    expect(screen.getByText('TypeScript, Python')).toBeTruthy();
    // Other answers now render exclusively as the italic "You typed: …"
    // form in the answer column — the prior layout duplicated the raw
    // value in a separate column too, which read as noise.
    expect(screen.getAllByText(/This is a test, custom, answer/).length).toBe(1);
    expect(screen.getByText(/You typed:.*This is a test/)).toBeTruthy();
    expect(screen.getAllByText(/You typed:/).length).toBe(1);
  });

  it('falls back to "(no answer recorded)" when the result content is missing', () => {
    render(
      <AnsweredAskUserQuestionCard
        input={input([{ question: 'Pick', options: [{ label: 'X' }] }])}
        resultContent={undefined}
      />,
    );
    expect(screen.getByText('(no answer recorded)')).toBeTruthy();
  });

  it('tolerates resultContent that is already a parsed object (some replay paths)', () => {
    // Tests are coupled to the implementation's "tolerate three shapes" rule
    // — if a future caller passes the parsed shape directly, the card should
    // still light up the answer column.
    render(
      <AnsweredAskUserQuestionCard
        input={input([{ question: 'Pick', options: [{ label: 'X' }] }])}
        // Cast to string-typed prop slot but pass an already-parsed object —
        // the parser branches on typeof body before JSON.parsing.
        resultContent={({ answers: { Pick: 'X' } } as unknown) as string}
      />,
    );
    expect(screen.getByText('X')).toBeTruthy();
  });

  it('renders nothing when the input has no questions', () => {
    const { container } = render(
      <AnsweredAskUserQuestionCard
        input={{ questions: [] }}
        resultContent={resultJson({})}
      />,
    );
    expect(container.querySelector('[data-testid="answered-ask-user-question-card"]')).toBeNull();
  });

  it('tolerates malformed JSON in resultContent without crashing', () => {
    render(
      <AnsweredAskUserQuestionCard
        input={input([{ question: 'Pick', options: [{ label: 'X' }] }])}
        resultContent="not valid json {{{"
      />,
    );
    // Card still renders the question; just no answer column.
    expect(screen.getByText('Pick')).toBeTruthy();
    expect(screen.getByText('(no answer recorded)')).toBeTruthy();
  });
});
