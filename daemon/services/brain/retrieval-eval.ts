/** Labels come from reformulation chains: the note a chain's final query surfaced is what its first query should have found. */

export interface SearchCall {
  /** Position among ALL tool uses, not searches alone: adjacency is the reformulation signal. */
  ordinal: number;
  query: string;
  results: string[];
}

export interface EvalCase {
  query: string;
  target: string;
  chain: string[];
}

export interface Scoreboard {
  n: number;
  recallAt1: number;
  recallAt5: number;
  recallAt20: number;
  mrr: number;
}

/** Input need not be sorted: walk order can differ from tool-use order with sidechains. */
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

const MIN_TOKEN = 3;

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

function sharesSubject(a: string, b: string): boolean {
  const left = stems(a);
  for (const s of stems(b)) if (left.has(s)) return true;
  return false;
}

/**
 * Adjacency alone is not a reformulation (only 27% of adjacent pairs shared a stem). A chain needs
 * two or more searches, a non-empty final result, a shared stem per adjacent pair, and a final query
 * different from the first.
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

export function rankOf(target: string, results: readonly string[]): number | null {
  const i = results.indexOf(target);
  return i === -1 ? null : i + 1;
}

/** A null rank contributes zero, never dropped, so the denominator is the full case count. */
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
