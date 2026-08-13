import { describe, expect, it, vi } from 'vitest';
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
    expect(parseCuration(raw)).toEqual({ collapsed: 'Early work.', promotedFacts: ['a'] });
  });

  it('defaults promotedFacts to an empty array', () => {
    expect(parseCuration('{"collapsed":"x"}')).toEqual({ collapsed: 'x', promotedFacts: [] });
  });

  it('throws CurationParseError when there is no JSON object', () => {
    expect(() => parseCuration('I could not do that.')).toThrow(CurationParseError);
  });

  it('throws CurationParseError when collapsed is missing', () => {
    expect(() => parseCuration('{"promotedFacts":[]}')).toThrow(CurationParseError);
  });

  it('throws CurationParseError when collapsed is empty', () => {
    expect(() => parseCuration('{"collapsed":"   "}')).toThrow(CurationParseError);
  });
});

describe('createCurator', () => {
  it('calls the pinned model with the account config dir', async () => {
    const runQuery = vi.fn().mockResolvedValue('{"collapsed":"ok","promotedFacts":[]}');
    const curator = createCurator({ runQuery });
    const out = await curator(INPUT, '/cfg');

    expect(out).toEqual({ collapsed: 'ok', promotedFacts: [] });
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery.mock.calls[0][0].model).toBe(CURATION_MODEL);
    expect(runQuery.mock.calls[0][0].configDir).toBe('/cfg');
  });

  it('is pinned to Opus, not to the extraction model', () => {
    expect(CURATION_MODEL).toBe('claude-opus-5');
  });

  it('retries exactly once on an unusable reply', async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce('nope')
      .mockResolvedValueOnce('{"collapsed":"second try","promotedFacts":[]}');
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
    const runQuery = vi.fn().mockResolvedValue('still nope');
    await expect(createCurator({ runQuery })(INPUT, '/cfg')).rejects.toThrow(CurationParseError);
    expect(runQuery).toHaveBeenCalledTimes(2);
  });
});
