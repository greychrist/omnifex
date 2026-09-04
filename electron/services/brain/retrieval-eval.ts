/**
 * Retrieval quality measurement for the Brain's search index.
 *
 * The problem this solves: the AND→OR fix was validated with "22 previously
 * empty queries now return hits", which measures *returned something*, not
 * *returned the right thing*. Any future change to ranking — section-level
 * indexing, embeddings, reweighting — needs a metric that can tell an
 * improvement from a regression, and that metric needs labels.
 *
 * Labels come from the model's own reformulation behaviour. Across the real
 * transcripts, 30 of 59 brain_search calls were immediately followed by
 * another brain_search: the model looked, did not get what it needed, and
 * rephrased. The note that the *final* query in such a chain surfaced is what
 * the *first* query should have surfaced. That yields a label per chain, for
 * free, from real traffic — and unlike the raw reformulation rate (a property
 * of a live session, not of an index) it can be replayed offline against a
 * modified index.
 *
 * Everything here is pure. Transcript reading and index querying live in
 * `scripts/brain-retrieval-eval.ts`, so this module can be tested without a
 * vault, a database, or a filesystem.
 */

/** One `brain_search` invocation recovered from a session transcript. */
export interface SearchCall {
  /**
   * Position within the session's full tool-use sequence — not within the
   * searches alone. Adjacency is the whole signal: two searches with
   * consecutive ordinals are a reformulation, whereas a gap means some other
   * tool ran in between and the model was acting on the first result rather
   * than retrying it.
   */
  ordinal: number;
  query: string;
  /** Returned `notePath`s, best-ranked first. Empty when nothing matched. */
  results: string[];
}

/** One labelled retrieval case: `query` should have found `target`. */
export interface EvalCase {
  /** The chain's first query — the one that failed and is being scored. */
  query: string;
  /** The note the chain's final query surfaced, treated as ground truth. */
  target: string;
  /** Every query in the chain, kept so a human can sanity-check the label. */
  chain: string[];
}

export interface Scoreboard {
  n: number;
  recallAt1: number;
  recallAt5: number;
  recallAt20: number;
  mrr: number;
}

/**
 * Split searches from one session into maximal runs of consecutive ordinals.
 *
 * Input need not be sorted; transcript walk order is not guaranteed to match
 * tool-use order once sidechains are involved.
 */
export function groupChains(calls: readonly SearchCall[]): SearchCall[][] {
  const sorted = [...calls].sort((a, b) => a.ordinal - b.ordinal);
  const chains: SearchCall[][] = [];
  let current: SearchCall[] = [];
  for (const c of sorted) {
    const prev = current[current.length - 1];
    if (prev !== undefined && c.ordinal !== prev.ordinal + 1) {
      chains.push(current);
      current = [];
    }
    current.push(c);
  }
  if (current.length > 0) chains.push(current);
  return chains;
}

/**
 * Shortest token worth treating as evidence of a shared subject.
 *
 * `db migrations` / `db rollback` share "db" and are two different questions.
 * Two-character tokens match too much to mean anything.
 */
const MIN_TOKEN = 3;

/**
 * Crude stem length. Enough that `indexing`/`indexer` and `migration`/
 * `migrations` collapse together, short of anything needing a stemmer
 * dependency for what is a similarity heuristic, not a search feature.
 */
const STEM = 5;

function stems(query: string): Set<string> {
  return new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= MIN_TOKEN)
      .map((t) => t.slice(0, STEM)),
  );
}

/** Whether two queries are plausibly about the same thing. */
function sharesSubject(a: string, b: string): boolean {
  const left = stems(a);
  for (const s of stems(b)) if (left.has(s)) return true;
  return false;
}

/**
 * Turn chains into labelled cases, discarding every kind that teaches nothing.
 *
 * Adjacency alone does not make a reformulation, which is what the first
 * version of this got wrong. Measured on the real transcripts, only 27% of
 * adjacent search pairs shared even a word stem: the rest were the model
 * asking its next question, not rephrasing its last one. Labelling
 * `node-pty leak` with the note that `turbopack cache` found does not produce
 * a weak benchmark, it produces a wrong one.
 *
 * So a chain must survive four filters:
 *   - two or more searches (a lone search would label the index with its own
 *     output, proving only that search is deterministic);
 *   - a final search that returned something (an empty one is the model giving
 *     up, leaving no target to learn);
 *   - every adjacent pair sharing a term stem (a chain that drifts one topic
 *     per hop ends somewhere its first query was never about);
 *   - a final query different from the first (an identical repeat returns
 *     identical results, so the label would be circular).
 */
export function chainsToCases(chains: readonly (readonly SearchCall[])[]): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const chain of chains) {
    if (chain.length < 2) continue;
    const first = chain[0];
    const last = chain[chain.length - 1];
    const target = last.results[0];
    if (target === undefined) continue;
    if (first.query.trim() === last.query.trim()) continue;
    const coherent = chain.every(
      (c, i) => i === 0 || sharesSubject(chain[i - 1].query, c.query),
    );
    if (!coherent) continue;
    cases.push({
      query: first.query,
      target,
      chain: chain.map((c) => c.query),
    });
  }
  return cases;
}

/** 1-indexed rank of `target` in `results`, or null when it is absent. */
export function rankOf(target: string, results: readonly string[]): number | null {
  const i = results.indexOf(target);
  return i === -1 ? null : i + 1;
}

/**
 * Recall at three cutoffs plus mean reciprocal rank.
 *
 * Recall@k answers "was the right note in the first k results" — the question
 * that matters for a model that reads what it is handed. MRR is kept beside it
 * because recall alone cannot distinguish rank 1 from rank 5, and moving a hit
 * from 5 to 1 is a real improvement that recall@5 scores as zero change.
 *
 * A null rank (target not retrieved at all) contributes zero everywhere rather
 * than being dropped, so the denominator stays the full case count.
 */
export function score(ranks: readonly (number | null)[]): Scoreboard {
  const n = ranks.length;
  if (n === 0) return { n: 0, recallAt1: 0, recallAt5: 0, recallAt20: 0, mrr: 0 };
  const within = (k: number): number =>
    ranks.filter((r) => r !== null && r <= k).length / n;
  const mrr = ranks.reduce<number>((sum, r) => sum + (r === null ? 0 : 1 / r), 0) / n;
  return {
    n,
    recallAt1: within(1),
    recallAt5: within(5),
    recallAt20: within(20),
    mrr,
  };
}
