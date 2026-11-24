// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { QuestionLine } from '../QuestionLine';

afterEach(() => { cleanup(); });

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
 * The wire-format string the CLI returns:
 *
 *   `Your questions have been answered: "Q"="A" notes: User selected Other: "A". You can now continue with these answers in mind.`
 *
 * Older builds emitted `User has answered your questions: … user notes: …`,
 * which still appears in real transcripts.
 */
function resultWire(
  answers: Record<string, string>,
  others?: string[],
): string {
  const pairs = Object.entries(answers)
    .map(([q, a]) => `"${q}"="${a}"`)
    .join(', ');
  const notes = others && others.length > 0
    ? ` notes: ${others.map((t) => `User selected Other: "${t}"`).join('. ')}`
    : '';
  return `Your questions have been answered: ${pairs}${notes}. You can now continue with these answers in mind.`;
}

// The legacy JSON shape, for the fallback path.
function resultJson(answers: Record<string, string>, annotations?: Record<string, { notes?: string }>) {
  return JSON.stringify({ answers, annotations });
}

describe('QuestionLine (wire format — synthesised string)', () => {
  it('renders one row per question with the header chip, question text, and answer', () => {
    render(
      <QuestionLine
        input={input([{ question: 'Pick a color', header: 'Color', options: [{ label: 'Red' }] }])}
        resultContent={resultWire({ 'Pick a color': 'Red' })}
      />,
    );

    const card = (document.querySelector('[data-question-line]') as HTMLElement);
    expect(within(card).getByText('Color')).toBeTruthy();
    expect(within(card).getByText('Pick a color')).toBeTruthy();
    expect(within(card).getByText('Red')).toBeTruthy();
  });

  it('renders the singular header for a single-question call', () => {
    render(
      <QuestionLine
        input={input([{ question: 'A?', options: [{ label: 'B' }] }])}
        resultContent={resultWire({ 'A?': 'B' })}
      />,
    );
    expect(screen.getByText('Question answered')).toBeTruthy();
  });

  it('renders the count header for multi-question calls', () => {
    render(
      <QuestionLine
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
    // The submit path joins multi-select picks with ', '; the parser anchors on the
    // question text, so the comma does not end the answer early.
    render(
      <QuestionLine
        input={input([{ question: 'Pick toppings', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }])}
        resultContent={resultWire({ 'Pick toppings': 'A, B' })}
      />,
    );
    expect(screen.getByText('A, B')).toBeTruthy();
  });

  it('shows the "Other:" form when the user selected Other (rendered once)', () => {
    render(
      <QuestionLine
        input={input([{ question: 'Pick', options: [{ label: 'X' }] }])}
        resultContent={resultWire({ Pick: 'Magenta' }, ['Magenta'])}
      />,
    );
    expect(screen.getByText(/Other:\s*Magenta/)).toBeTruthy();
    expect(screen.getAllByText(/Magenta/).length).toBe(1);
    expect(screen.queryByText(/You typed/)).toBeNull();
  });

  it('omits the "Other:" line when there is no annotation', () => {
    render(
      <QuestionLine
        input={input([{ question: 'Pick', options: [{ label: 'X' }] }])}
        resultContent={resultWire({ Pick: 'X' })}
      />,
    );
    expect(screen.queryByText(/Other:/)).toBeNull();
  });

  it('parses the legacy "user notes:" wire format (session d6ac42ec) verbatim', () => {
    // The older CLI form (`User has answered your questions: … user notes: …`)
    // still appears in real transcripts.
    const liveContent =
      'User has answered your questions: ' +
      '"Which color do you prefer?"="Blue", ' +
      '"Which programming languages do you use regularly?"="TypeScript, Python", ' +
      '"How should I proceed with verification by default?"="This is a test, custom, answer.  I want to see how it looks, especially when it\'s longer.  Hopefully it will look nice."' +
      ' user notes: User selected Other: "This is a test, custom, answer.  I want to see how it looks, especially when it\'s longer.  Hopefully it will look nice."' +
      '. You can now continue with the user\'s answers in mind.';

    render(
      <QuestionLine
        input={input([
          { question: 'Which color do you prefer?', header: 'Color', options: [{ label: 'Blue' }, { label: 'Red' }, { label: 'Green' }] },
          { question: 'Which programming languages do you use regularly?', header: 'Languages', options: [{ label: 'TypeScript' }, { label: 'Python' }, { label: 'Rust' }, { label: 'Go' }], multiSelect: true },
          { question: 'How should I proceed with verification by default?', header: 'Verify mode', options: [{ label: 'Run npm run check only (Recommended)' }] },
        ])}
        resultContent={liveContent}
      />,
    );

    expect(screen.queryByText(/no answer recorded/i)).toBeNull();
    expect(screen.getByText('Blue')).toBeTruthy();
    expect(screen.getByText('TypeScript, Python')).toBeTruthy();
    expect(screen.getAllByText(/This is a test, custom, answer/).length).toBe(1);
    expect(screen.getByText(/Other:.*This is a test/)).toBeTruthy();
    expect(screen.getAllByText(/Other:/).length).toBe(1);
  });

  it('parses the current CLI wire format (" notes:" delimiter, "Your questions have been answered" prefix)', () => {
    // The CLI drifted from "… user notes: …" to "Your questions have been
    // answered: … notes: …".
    const liveContent =
      'Your questions have been answered: ' +
      '"The verify gate\'s a11y stage fails on the home-page YouTube iframe (third-party markup), unrelated to WS-203. How do you want to handle it so the billing work can land?"=' +
      '"I\'ve already fixed this and ported the fix to develop - you can verify that but we don\'t need to fix it here."' +
      ' notes: User selected Other: "I\'ve already fixed this and ported the fix to develop - you can verify that but we don\'t need to fix it here."' +
      '. You can now continue with these answers in mind.';

    render(
      <QuestionLine
        input={input([
          {
            question:
              "The verify gate's a11y stage fails on the home-page YouTube iframe (third-party markup), unrelated to WS-203. How do you want to handle it so the billing work can land?",
            header: 'A11Y BLOCKER',
            options: [{ label: 'Skip it' }],
          },
        ])}
        resultContent={liveContent}
      />,
    );

    expect(screen.getAllByText(/I've already fixed this and ported the fix to develop/).length).toBe(1);
    expect(screen.getByText(/Other:\s*I've already fixed this/)).toBeTruthy();
    expect(screen.queryByText(/User selected Other/)).toBeNull();
    expect(screen.queryByText(/(?:^|\s)notes:/)).toBeNull();
  });

  it('falls back to "No answer recorded" when the result content is missing', () => {
    render(
      <QuestionLine
        input={input([{ question: 'Pick', options: [{ label: 'X' }] }])}
        resultContent={undefined}
      />,
    );
    expect(screen.getByText(/no answer recorded/i)).toBeTruthy();
  });

  it('tolerates resultContent that is already a parsed object (some replay paths)', () => {
    render(
      <QuestionLine
        input={input([{ question: 'Pick', options: [{ label: 'X' }] }])}
        resultContent={({ answers: { Pick: 'X' } } as unknown) as string}
      />,
    );
    expect(screen.getByText('X')).toBeTruthy();
  });

  it('renders nothing when the input has no questions', () => {
    const { container } = render(
      <QuestionLine
        input={{ questions: [] }}
        resultContent={resultJson({})}
      />,
    );
    expect(container.querySelector('[data-testid="answered-ask-user-question-card"]')).toBeNull();
  });

  it('tolerates malformed JSON in resultContent without crashing', () => {
    render(
      <QuestionLine
        input={input([{ question: 'Pick', options: [{ label: 'X' }] }])}
        resultContent="not valid json {{{"
      />,
    );
    expect(screen.getByText('Pick')).toBeTruthy();
    expect(screen.getByText(/no answer recorded/i)).toBeTruthy();
  });
});

describe('QuestionLine (CLI trailer drift — "Read the answers carefully")', () => {
  // The CLI drifted again: prefix "The user answered:", trailer "Read the
  // answers carefully — …". The trailer is the terminal boundary.
  const TRAILER =
    '. Read the answers carefully — they may request clarification, changes, ' +
    'or that you not proceed — and follow what they actually say.';

  it('parses every answer, including the last, with the new trailer', () => {
    const liveContent =
      'The user answered: ' +
      '"There\'s already a CostsView embedded as a sub-tab inside the Usage dashboard (range presets, account filter, groupBy, rescan). What happens to it?"="Keep both", ' +
      '"How much lands in this branch?"="Everything, staged commits (Recommended)", ' +
      '"Which filters does the page need, and should they be multi-select?"="Date range incl. custom start/end, Account, model, project — all multi-select, Main-loop vs subagent toggle, Free-text project search", ' +
      '"Effective-dated pricing (brief §5b) — rates as {from, input, output} periods instead of flat numbers?"="Port it now, OmniFex-only (Recommended)"' +
      TRAILER;

    render(
      <QuestionLine
        input={input([
          { question: "There's already a CostsView embedded as a sub-tab inside the Usage dashboard (range presets, account filter, groupBy, rescan). What happens to it?", header: 'Old view', options: [{ label: 'Keep both' }] },
          { question: 'How much lands in this branch?', header: 'Scope', options: [{ label: 'Everything, staged commits (Recommended)' }] },
          { question: 'Which filters does the page need, and should they be multi-select?', header: 'Filters', options: [{ label: 'Account' }], multiSelect: true },
          { question: 'Effective-dated pricing (brief §5b) — rates as {from, input, output} periods instead of flat numbers?', header: 'Pricing', options: [{ label: 'Port it now, OmniFex-only (Recommended)' }] },
        ])}
        resultContent={liveContent}
      />,
    );

    expect(screen.queryByText(/no answer recorded/i)).toBeNull();
    expect(screen.getByText('Keep both')).toBeTruthy();
    expect(screen.getByText('Everything, staged commits (Recommended)')).toBeTruthy();
    expect(screen.getByText('Date range incl. custom start/end, Account, model, project — all multi-select, Main-loop vs subagent toggle, Free-text project search')).toBeTruthy();
    expect(screen.getByText('Port it now, OmniFex-only (Recommended)')).toBeTruthy();
    expect(screen.queryByText(/Read the answers carefully/)).toBeNull();
  });

  it('keeps the Other annotation working under the new trailer', () => {
    const typed = "Yes it's a generation. There should be an 'are you sure' to gate that.";
    const liveContent =
      `The user answered: "Regenerate?"="${typed}"` +
      ` notes: User selected Other: "${typed}"` +
      TRAILER;

    render(
      <QuestionLine
        input={input([{ question: 'Regenerate?', header: 'Regen', options: [{ label: 'No' }] }])}
        resultContent={liveContent}
      />,
    );

    expect(screen.getAllByText(new RegExp('There should be an')).length).toBe(1);
    expect(screen.getByText(/Other:\s*Yes it's a generation/)).toBeTruthy();
    expect(screen.queryByText(/User selected Other/)).toBeNull();
    expect(screen.queryByText(/Read the answers carefully/)).toBeNull();
  });
});
