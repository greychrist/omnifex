import { describe, expect, it } from 'vitest';
import {
  chainsToCases,
  groupChains,
  rankOf,
  score,
  type SearchCall,
} from '../services/brain/retrieval-eval';

/** Terse constructor so the tests read as data, not as object literals. */
function call(ordinal: number, query: string, ...results: string[]): SearchCall {
  return { ordinal, query, results };
}

describe('groupChains', () => {
  it('groups searches with adjacent ordinals into one chain', () => {
    const chains = groupChains([
      call(0, 'encompass ops', 'A.md'),
      call(1, 'encompass backend flyway', 'B.md'),
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0].map((c) => c.query)).toEqual([
      'encompass ops',
      'encompass backend flyway',
    ]);
  });

  it('splits when another tool ran between two searches', () => {
    // Ordinals 0 and 2 mean a non-search tool use occupied slot 1 — the model
    // acted on the first result rather than reformulating, so these are not
    // one chain.
    const chains = groupChains([call(0, 'first', 'A.md'), call(2, 'second', 'B.md')]);
    expect(chains).toHaveLength(2);
  });

  it('tolerates unsorted input', () => {
    const chains = groupChains([call(1, 'second', 'B.md'), call(0, 'first', 'A.md')]);
    expect(chains).toHaveLength(1);
    expect(chains[0].map((c) => c.query)).toEqual(['first', 'second']);
  });

  it('returns nothing for no calls', () => {
    expect(groupChains([])).toEqual([]);
  });
});

describe('chainsToCases', () => {
  it("takes the chain's first query and the final query's top hit", () => {
    const cases = chainsToCases([
      [
        call(0, 'encompass ops'),
        call(1, 'encompass backend flyway', 'Subsystems/flyway.md', 'Other.md'),
      ],
    ]);
    expect(cases).toEqual([
      {
        query: 'encompass ops',
        target: 'Subsystems/flyway.md',
        chain: ['encompass ops', 'encompass backend flyway'],
      },
    ]);
  });

  it('drops single-search chains', () => {
    // A lone successful search would label the index with its own output —
    // measuring the index against itself proves nothing.
    expect(chainsToCases([[call(0, 'lone', 'A.md')]])).toEqual([]);
  });

  it('drops chains whose final search found nothing', () => {
    // The model gave up rather than succeeding, so there is no target to learn.
    expect(chainsToCases([[call(0, 'flyway migration', 'A.md'), call(1, 'flyway baseline')]]))
      .toEqual([]);
  });

  it('uses the last query in a chain longer than two', () => {
    const cases = chainsToCases([
      [
        call(0, 'brain indexing', 'X.md'),
        call(1, 'brain indexer', 'Y.md'),
        call(2, 'brain indexer tokens', 'Z.md'),
      ],
    ]);
    expect(cases[0]).toMatchObject({ query: 'brain indexing', target: 'Z.md' });
    expect(cases[0].chain).toHaveLength(3);
  });

  it('drops chains whose queries share no term — those are topic switches', () => {
    // The failure this guards against, straight from the real transcripts:
    // `node-pty leak` followed by `turbopack cache` is the model asking a
    // second, unrelated question, not rephrasing the first. Treating it as a
    // reformulation labels the index with a note the query was never after.
    expect(
      chainsToCases([[call(0, 'node-pty leak', 'A.md'), call(1, 'turbopack cache', 'B.md')]]),
    ).toEqual([]);
  });

  it('requires EVERY adjacent pair to share a term, not just some', () => {
    // `encompass architecture → EEP template → errProof → work order` drifts
    // one topic at a time; no single hop looks wild but the endpoints are
    // unrelated, so the first query must not be labelled with the last hit.
    expect(
      chainsToCases([
        [
          call(0, 'encompass architecture', 'A.md'),
          call(1, 'encompass template', 'B.md'),
          call(2, 'work order', 'C.md'),
        ],
      ]),
    ).toEqual([]);
  });

  it('matches on stems so inflections still count as a reformulation', () => {
    const cases = chainsToCases([
      [call(0, 'indexing cost', 'A.md'), call(1, 'indexer spend', 'B.md')],
    ]);
    expect(cases[0]).toMatchObject({ query: 'indexing cost', target: 'B.md' });
  });

  it('ignores tokens too short to disambiguate', () => {
    // Two-character tokens match too much to be evidence of a shared subject.
    expect(chainsToCases([[call(0, 'db migrations', 'A.md'), call(1, 'db rollback', 'B.md')]]))
      .toEqual([]);
  });

  it('drops chains that end where they started', () => {
    // An identical repeat returns identical results, so the label would be the
    // query's own top hit — circular.
    expect(chainsToCases([[call(0, 'node-pty', 'A.md'), call(1, 'node-pty', 'A.md')]])).toEqual(
      [],
    );
  });
});

describe('rankOf', () => {
  it('is 1-indexed', () => {
    expect(rankOf('B.md', ['A.md', 'B.md'])).toBe(2);
  });

  it('is null when the target is absent', () => {
    expect(rankOf('Z.md', ['A.md', 'B.md'])).toBeNull();
  });

  it('is null for an empty result set', () => {
    expect(rankOf('A.md', [])).toBeNull();
  });
});

describe('score', () => {
  it('computes recall at each cutoff and MRR', () => {
    const s = score([1, 3, null, 12]);
    expect(s.n).toBe(4);
    expect(s.recallAt1).toBeCloseTo(0.25);
    expect(s.recallAt5).toBeCloseTo(0.5);
    expect(s.recallAt20).toBeCloseTo(0.75);
    // (1/1 + 1/3 + 0 + 1/12) / 4
    expect(s.mrr).toBeCloseTo((1 + 1 / 3 + 0 + 1 / 12) / 4);
  });

  it('reports zeroes rather than NaN for an empty run', () => {
    expect(score([])).toEqual({
      n: 0,
      recallAt1: 0,
      recallAt5: 0,
      recallAt20: 0,
      mrr: 0,
    });
  });

  it('counts a rank exactly at a cutoff as a hit', () => {
    expect(score([5]).recallAt5).toBe(1);
    expect(score([20]).recallAt20).toBe(1);
    expect(score([21]).recallAt20).toBe(0);
  });
});
