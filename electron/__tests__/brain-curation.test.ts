import { describe, expect, it, vi } from 'vitest';
import type { CliRunResult } from '../services/sessions/summary-query';
/**
 * A `claude -p` result carrying just the reply. The runner now returns the
 * CLI's cost accounting alongside the text; these tests are about the text.
 */
function reply(text: string): CliRunResult {
  return {
    result: text,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    durationMs: null,
  };
}

import {
  CURATION_MODEL,
  CurationParseError,
  buildCurationPrompt,
  createCurator,
  parseCuration,
} from '../services/brain/curation';

const INPUT = {
  title: 'Widget',
  noteType: 'Subsystem',
  entries: [
    '- **2026-01-01**: Specified the flange.',
    '- **2026-01-04**: Revised the flange.',
  ],
};

describe('buildCurationPrompt', () => {
  it('states the note, the span and the entries verbatim', () => {
    const prompt = buildCurationPrompt(INPUT);
    expect(prompt).toContain('Widget');
    expect(prompt).toContain('Subsystem');
    expect(prompt).toContain('2026-01-01');
    expect(prompt).toContain('2026-01-04');
    expect(prompt).toContain('Specified the flange.');
  });

  it('tells the model it is summarizing, not choosing what to remove', () => {
    const prompt = buildCurationPrompt(INPUT);
    expect(prompt).toContain('already been selected');
  });

  it('asks for exactly the two fields, and nothing else', () => {
    const prompt = buildCurationPrompt(INPUT);
    expect(prompt).toContain('"collapsed"');
    expect(prompt).toContain('"promotedFacts"');
  });
});

describe('parseCuration', () => {
  it('accepts a fenced reply with prose around it', () => {
    const raw = 'Sure!\n```json\n{"collapsed":"Early work.","promotedFacts":["a"]}\n```\nDone.';
    expect(parseCuration(raw)).toEqual({
      collapsed: 'Early work.',
      collapsedDecisions: '',
      promotedFacts: ['a'],
    });
  });

  it('defaults promotedFacts to an empty array', () => {
    expect(parseCuration('{"collapsed":"x"}')).toEqual({
      collapsed: 'x',
      collapsedDecisions: '',
      promotedFacts: [],
    });
  });

  it('throws CurationParseError when there is no JSON object', () => {
    expect(() => parseCuration('I could not do that.')).toThrow(CurationParseError);
  });

  it('throws CurationParseError when both prose fields are missing', () => {
    expect(() => parseCuration('{"promotedFacts":[]}')).toThrow(CurationParseError);
  });

  it('throws CurationParseError when both prose fields are empty', () => {
    expect(() => parseCuration('{"collapsed":"   "}')).toThrow(CurationParseError);
  });

  it('accepts a reply carrying only the decisions span', () => {
    // A note qualifying on Decisions alone is shown one block and has nothing
    // to say about a Timeline span it was never given.
    expect(parseCuration('{"collapsedDecisions":"Settled the flange."}')).toEqual({
      collapsed: '',
      collapsedDecisions: 'Settled the flange.',
      promotedFacts: [],
    });
  });
});

describe('createCurator', () => {
  it('calls the pinned model with the account config dir', async () => {
    const runQuery = vi.fn().mockResolvedValue(reply('{"collapsed":"ok","promotedFacts":[]}'));
    const curator = createCurator({ runQuery });
    const out = await curator(INPUT, '/cfg');

    expect(out).toMatchObject({ collapsed: 'ok', promotedFacts: [] });
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery.mock.calls[0][0].model).toBe(CURATION_MODEL);
    expect(runQuery.mock.calls[0][0].configDir).toBe('/cfg');
  });

  /**
   * Plan 8. The runner used to keep `result` and drop the rest of the envelope,
   * so the most expensive thing the Brain does was also the only spend nothing
   * could report.
   */
  it('carries what the run cost back to the caller', async () => {
    const runQuery = vi.fn().mockResolvedValue({
      ...reply('{"collapsed":"ok","promotedFacts":[]}'),
      costUsd: 0.4,
      inputTokens: 1200,
    });
    const out = await createCurator({ runQuery })(INPUT, '/cfg');

    expect(out.run).toMatchObject({ costUsd: 0.4, inputTokens: 1200 });
  });

  it('bills both legs when it retries, not only the one that worked', async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce({ ...reply('nope'), costUsd: 0.1, inputTokens: 10 })
      .mockResolvedValueOnce({
        ...reply('{"collapsed":"second try","promotedFacts":[]}'),
        costUsd: 0.3,
        inputTokens: 30,
      });
    const out = await createCurator({ runQuery })(INPUT, '/cfg');

    // A retry is money spent on top of the first attempt, not instead of it.
    expect(out.run).toMatchObject({ costUsd: 0.4, inputTokens: 40 });
  });

  it('is pinned to Opus, not to the extraction model', () => {
    expect(CURATION_MODEL).toBe('claude-opus-5');
  });

  it('retries exactly once on an unusable reply', async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(reply('nope'))
      .mockResolvedValueOnce(reply('{"collapsed":"second try","promotedFacts":[]}'));
    const out = await createCurator({ runQuery })(INPUT, '/cfg');

    expect(out.collapsed).toBe('second try');
    expect(runQuery).toHaveBeenCalledTimes(2);
  });

  it('does not retry a transport failure', async () => {
    const runQuery = vi.fn().mockRejectedValue(new Error('spawn failed'));
    await expect(createCurator({ runQuery })(INPUT, '/cfg')).rejects.toThrow('spawn failed');
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it('propagates a second bad reply rather than looping', async () => {
    const runQuery = vi.fn().mockResolvedValue(reply('still nope'));
    await expect(createCurator({ runQuery })(INPUT, '/cfg')).rejects.toThrow(CurationParseError);
    expect(runQuery).toHaveBeenCalledTimes(2);
  });
});
