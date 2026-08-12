import { describe, it, expect } from 'vitest';
import {
  createExtractor,
  parseExtraction,
  ExtractionParseError,
} from '../services/brain/extract';
import type { DistilledItem } from '../services/brain/sources/types';

const VALID = {
  entities: [
    {
      type: 'Subsystem',
      name: 'Permission decider',
      aliases: ['permission-prompt-tool'],
      keywords: ['permissions', 'stdio'],
      summary: 'The stdio bridge that enforces mid-session permission changes.',
      links: [{ target: 'Projects/omnifex', relation: 'lives in' }],
      timelineEntry: 'Reworked the decider to handle every mode, not just bypass.',
      decisions: [{ date: '2026-05-31', text: 'Enforce in OmniFex, not the CLI.' }],
      keyFacts: ['Only bypass was handled before this change.'],
    },
  ],
};

describe('parseExtraction', () => {
  it('parses a clean JSON reply', () => {
    expect(parseExtraction(JSON.stringify(VALID)).entities).toHaveLength(1);
  });

  it('parses JSON wrapped in a markdown fence', () => {
    // The CLI returns the model's text verbatim, and a model asked for JSON
    // fences it more often than not. Rejecting that would fail most calls for
    // a reason that has nothing to do with the content.
    const fenced = '```json\n' + JSON.stringify(VALID) + '\n```';
    expect(parseExtraction(fenced).entities).toHaveLength(1);
  });

  it('parses JSON with prose before and after it', () => {
    const chatty = `Here is the extraction:\n${JSON.stringify(VALID)}\nLet me know if you need more.`;
    expect(parseExtraction(chatty).entities).toHaveLength(1);
  });

  it('is not fooled by a brace inside trailing prose', () => {
    // A greedy first-{-to-last-} slice would swallow this and fail to parse.
    const trailing = `${JSON.stringify(VALID)}\nNote: the config uses {braces} too.`;
    expect(parseExtraction(trailing).entities).toHaveLength(1);
  });

  it('is not fooled by a brace inside a JSON string value', () => {
    const braced = {
      entities: [
        { type: 'Topic', name: 'Templating', summary: 'Uses {{handlebars}} syntax.' },
      ],
    };
    expect(parseExtraction(JSON.stringify(braced)).entities[0].summary).toContain('{{handlebars}}');
  });

  it('defaults the optional collections so merge never sees undefined', () => {
    const minimal = { entities: [{ type: 'Topic', name: 'X', summary: 'A topic.' }] };
    const parsed = parseExtraction(JSON.stringify(minimal));
    expect(parsed.entities[0].aliases).toEqual([]);
    expect(parsed.entities[0].keywords).toEqual([]);
    expect(parsed.entities[0].links).toEqual([]);
    expect(parsed.entities[0].decisions).toEqual([]);
    expect(parsed.entities[0].keyFacts).toEqual([]);
  });

  it('rejects an unknown entity type with a readable message', () => {
    const bad = { entities: [{ type: 'Person', name: 'X', summary: 'y' }] };
    expect(() => parseExtraction(JSON.stringify(bad))).toThrow(ExtractionParseError);
    expect(() => parseExtraction(JSON.stringify(bad))).toThrow(/type/i);
  });

  it('rejects a reply containing no JSON at all', () => {
    expect(() => parseExtraction('I could not find anything worth noting.')).toThrow(
      ExtractionParseError,
    );
  });

  it('rejects an empty entity name, which would produce an unnameable note', () => {
    const bad = { entities: [{ type: 'Topic', name: '   ', summary: 'y' }] };
    expect(() => parseExtraction(JSON.stringify(bad))).toThrow(ExtractionParseError);
  });

  it('rejects malformed JSON with the parse error attached', () => {
    expect(() => parseExtraction('{"entities": [')).toThrow(ExtractionParseError);
  });

  it('accepts an empty entity list — a session can be worth nothing', () => {
    expect(parseExtraction('{"entities":[]}').entities).toEqual([]);
  });

  it('normalizes a folder-qualified name to its last segment', () => {
    // Observed from a live Sonnet run: the prompt shows `links.target` as
    // "Projects/omnifex" and the model generalized that to `name`. A name with
    // a separator is rejected outright by vault.notePath, so one bad name
    // would otherwise fail the whole item. Last-segment matches how
    // linkMatchesNote already resolves wikilinks.
    const q = { entities: [{ type: 'Project', name: 'Projects/omnifex', summary: 'x' }] };
    expect(parseExtraction(JSON.stringify(q)).entities[0].name).toBe('omnifex');
  });

  it('rejects a name that is only a separator', () => {
    const bad = { entities: [{ type: 'Topic', name: 'Topics/', summary: 'x' }] };
    expect(() => parseExtraction(JSON.stringify(bad))).toThrow(ExtractionParseError);
  });

  it('normalizes a backslash-qualified name too', () => {
    const q = { entities: [{ type: 'Topic', name: 'Topics\\Thing', summary: 'x' }] };
    expect(parseExtraction(JSON.stringify(q)).entities[0].name).toBe('Thing');
  });
});

const ITEM: DistilledItem = {
  prose: 'USER: add a probe\nASSISTANT: added one',
  truncated: false,
  metadata: {
    sessionId: 'sess-a',
    projectPath: '/repo',
    gitBranch: 'main',
    models: ['claude-opus-5'],
    cliVersion: '2.1.228',
    startedAt: '2026-08-01T10:00:00.000Z',
    endedAt: '2026-08-01T10:05:00.000Z',
    durationMs: 300_000,
    promptCount: 2,
    proseCount: 2,
    filesTouched: ['/repo/a.ts'],
    terminalStatus: 'completed',
  },
};

describe('createExtractor', () => {
  it('calls the CLI once with the pinned model and the owning config dir', async () => {
    const calls: { model: string; configDir: string; prompt: string }[] = [];
    const extract = createExtractor({
      runQuery: async (opts) => {
        calls.push(opts);
        return '{"entities":[]}';
      },
    });

    await extract(ITEM, '/Users/dev/.claude-work');

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('claude-sonnet-5');
    // The OWNING account's dir. Indexing a work transcript through the
    // personal account would push work content through the wrong
    // subscription (spec §8).
    expect(calls[0].configDir).toBe('/Users/dev/.claude-work');
  });

  it('puts the distilled prose and the deterministic metadata in the prompt', async () => {
    let prompt = '';
    const extract = createExtractor({
      runQuery: async (opts) => {
        prompt = opts.prompt;
        return '{"entities":[]}';
      },
    });
    await extract(ITEM, '/cfg');
    expect(prompt).toContain('USER: add a probe');
    expect(prompt).toContain('/repo');
    expect(prompt).toContain('main');
    // The model supplies prose and aliases only; these facts are handed to it,
    // never asked for (spec §6).
    expect(prompt).toContain('sess-a');
  });

  it('tells the model when it is looking at a truncated tail', async () => {
    let prompt = '';
    const extract = createExtractor({
      runQuery: async (opts) => {
        prompt = opts.prompt;
        return '{"entities":[]}';
      },
    });
    await extract({ ...ITEM, truncated: true }, '/cfg');
    expect(prompt).toMatch(/truncat/i);
  });

  it('says nothing about truncation when the transcript was whole', async () => {
    let prompt = '';
    const extract = createExtractor({
      runQuery: async (opts) => {
        prompt = opts.prompt;
        return '{"entities":[]}';
      },
    });
    await extract(ITEM, '/cfg');
    expect(prompt).not.toMatch(/truncat/i);
  });

  it('retries exactly once on an invalid reply, then succeeds', async () => {
    let n = 0;
    const extract = createExtractor({
      runQuery: async () => {
        n += 1;
        return n === 1 ? 'sorry, no idea' : '{"entities":[]}';
      },
    });
    await expect(extract(ITEM, '/cfg')).resolves.toEqual({ entities: [] });
    expect(n).toBe(2);
  });

  it('gives up after the retry and throws the validation error', async () => {
    let n = 0;
    const extract = createExtractor({
      runQuery: async () => {
        n += 1;
        return 'still not json';
      },
    });
    // Spec §8: one retry, then `failed` with the error visible. Retrying
    // further would spend tokens on a model that has already demonstrated it
    // cannot answer this one.
    await expect(extract(ITEM, '/cfg')).rejects.toThrow(ExtractionParseError);
    expect(n).toBe(2);
  });

  it('does not retry a transport failure', async () => {
    let n = 0;
    const extract = createExtractor({
      runQuery: async () => {
        n += 1;
        throw new Error('claude -p exited 1: not logged in');
      },
    });
    // A spawn/auth failure is not a bad answer — retrying it immediately just
    // fails twice as fast and doubles the log noise.
    await expect(extract(ITEM, '/cfg')).rejects.toThrow(/not logged in/);
    expect(n).toBe(1);
  });
});
