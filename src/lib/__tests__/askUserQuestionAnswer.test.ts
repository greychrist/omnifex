import { describe, it, expect } from 'vitest';
import { buildAskUserQuestionAnswer, OTHER_VALUE } from '../askUserQuestionAnswer';

const raw = [
  { question: 'DB?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
  { question: 'Extras?', multiSelect: true, options: [{ label: 'Cache' }, { label: 'Queue' }] },
];
const questions = raw.map((q) => ({ question: q.question, multiSelect: q.multiSelect === true }));

describe('buildAskUserQuestionAnswer', () => {
  it('echoes the questions and joins multi-select picks with ", "', () => {
    expect(buildAskUserQuestionAnswer(raw, questions, ['Postgres', ['Cache', 'Queue']], ['', ''])).toEqual({
      questions: raw,
      answers: { 'DB?': 'Postgres', 'Extras?': 'Cache, Queue' },
    });
  });

  it('swaps Other for the typed text and notes it', () => {
    expect(buildAskUserQuestionAnswer(raw, questions, [OTHER_VALUE, ['Cache', OTHER_VALUE]], [' MySQL ', 'Cron'])).toEqual({
      questions: raw,
      answers: { 'DB?': 'MySQL', 'Extras?': 'Cache, Cron' },
      annotations: {
        'DB?': { notes: 'User selected Other: "MySQL"' },
        'Extras?': { notes: 'User selected Other: "Cron"' },
      },
    });
  });
});
