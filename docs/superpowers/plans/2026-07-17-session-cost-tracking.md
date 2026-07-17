# Session Cost Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accurate, live, per-session cost for token-billed accounts (header widget), correct per-message and dashboard costs, and a durable SQLite cost history with a filterable Costs view.

**Architecture:** A pure pricing module (`src/lib/pricing.ts`) shared by renderer and main. Main-process services under `electron/services/cost/`: a pure JSONL usage extractor with requestId dedup, a pure per-session cost computer, a DB-backed history service (`session_cost_daily` table), and a live watcher that polls a session's JSONL + subagent files, pushes `session-cost:<sessionId>` events, and upserts history. Renderer consumes via new IPC channels + a `useSessionCost` hook.

**Tech Stack:** TypeScript, Electron (main services + IPC), better-sqlite3, React 18, vitest.

**Spec:** `docs/superpowers/specs/2026-07-17-session-cost-tracking-design.md` — authoritative for rates and semantics.

## Global Constraints

- Work on branch `session-cost-tracking` in the main checkout. **No worktrees** (repo rule).
- TDD: failing test first, then implementation. Tests live in `electron/__tests__/*.test.ts` (main) and `src/lib/__tests__/*.test.ts` (renderer lib). Both are in vitest's include globs.
- After any vitest run that precedes Greg restarting the app: `npm run rebuild:electron` (ABI).
- Every new invoke channel MUST be added to `INVOKE_CHANNELS` in `electron/ipc/channels.ts` (preload rejects otherwise). Event channel `session-cost:<id>` needs NO new prefix — `'session-'` is already in `EVENT_CHANNEL_PREFIXES` (channels.ts:221).
- Handler adapters accept camelCase AND snake_case params: `(p?.configDir ?? p?.config_dir) as string`.
- Renderer calls go through `src/lib/api.ts` (`apiCall`), never `window.electronAPI.invoke` directly; event subscription uses `window.electronAPI.onEvent` (returns unsubscribe).
- Rates (USD per MTok): fable/mythos 10/50 · opus-4-5..4-8 5/25 · legacy opus 15/75 · sonnet 3/15 · haiku-4-5 1/5 · legacy haiku 0.25/1.25. Cache read = 0.1× input; cache write = 1.25× input (5m TTL) / 2× input (1h TTL). Unknown model → sonnet rates + `estimated: true`.
- Dedup key for usage-bearing JSONL lines: `requestId` ?? `message.id` ?? per-line fallback; **last occurrence wins**.
- Dates in `session_cost_daily` are UTC calendar dates = `timestamp.slice(0, 10)` (JSONL timestamps are Z-suffixed ISO).
- Commit per task on the branch. Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Branch + shared pricing module

**Files:**
- Create: `src/lib/pricing.ts`
- Test: `electron/__tests__/pricing.test.ts`

**Interfaces:**
- Produces (used by every later task):
  - `interface ModelRates { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }` — USD **per token**.
  - `interface PricingOverride { input?: number; output?: number; cacheRead?: number; cacheWrite5m?: number; cacheWrite1h?: number }` — USD **per MTok**.
  - `type PricingOverrides = Record<string, PricingOverride>` — key is a model-id substring pattern.
  - `interface UsageTokens { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } }`
  - `interface MessageCost { usd: number; estimated: boolean; inputUsd: number; outputUsd: number; cacheReadUsd: number; cacheWriteUsd: number }`
  - `resolveRates(model: string, overrides?: PricingOverrides): { rates: ModelRates; estimated: boolean }`
  - `computeMessageCost(model: string, usage: UsageTokens, overrides?: PricingOverrides): MessageCost`
  - `splitCacheWriteTokens(usage: UsageTokens): { t5m: number; t1h: number }`
  - `parsePricingOverrides(json: string | null | undefined): PricingOverrides | undefined`

- [ ] **Step 1: Create branch**

```bash
cd ~/Repos/personal/omnifex && git checkout -b session-cost-tracking
```

- [ ] **Step 2: Write the failing test**

Create `electron/__tests__/pricing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  resolveRates,
  computeMessageCost,
  splitCacheWriteTokens,
  parsePricingOverrides,
} from '../../src/lib/pricing';

const M = 1_000_000;

describe('resolveRates', () => {
  it('prices current model families', () => {
    expect(resolveRates('claude-fable-5').rates.input).toBeCloseTo(10 / M, 12);
    expect(resolveRates('claude-fable-5').rates.output).toBeCloseTo(50 / M, 12);
    expect(resolveRates('claude-opus-4-8').rates.input).toBeCloseTo(5 / M, 12);
    expect(resolveRates('claude-opus-4-8').rates.output).toBeCloseTo(25 / M, 12);
    expect(resolveRates('claude-sonnet-5').rates.input).toBeCloseTo(3 / M, 12);
    expect(resolveRates('claude-haiku-4-5-20251001').rates.input).toBeCloseTo(1 / M, 12);
  });

  it('specific patterns beat family patterns (opus-4-8 is not legacy opus)', () => {
    expect(resolveRates('claude-opus-4-1').rates.input).toBeCloseTo(15 / M, 12);
    expect(resolveRates('claude-opus-4-8').rates.input).toBeCloseTo(5 / M, 12);
    expect(resolveRates('claude-3-5-haiku').rates.input).toBeCloseTo(0.25 / M, 12);
  });

  it('derives cache rates from input rate', () => {
    const { rates } = resolveRates('claude-opus-4-8');
    expect(rates.cacheRead).toBeCloseTo((5 / M) * 0.1, 12);
    expect(rates.cacheWrite5m).toBeCloseTo((5 / M) * 1.25, 12);
    expect(rates.cacheWrite1h).toBeCloseTo((5 / M) * 2, 12);
  });

  it('unknown model falls back to sonnet rates flagged estimated', () => {
    const r = resolveRates('claude-newthing-9');
    expect(r.estimated).toBe(true);
    expect(r.rates.input).toBeCloseTo(3 / M, 12);
  });

  it('overrides apply per-MTok, longest pattern wins, and clear estimated', () => {
    const overrides = { opus: { input: 99 }, 'opus-4-8': { input: 4, output: 20 } };
    const r = resolveRates('claude-opus-4-8', overrides);
    expect(r.rates.input).toBeCloseTo(4 / M, 12);
    expect(r.rates.output).toBeCloseTo(20 / M, 12);
    // cache rates re-derive from overridden input
    expect(r.rates.cacheWrite5m).toBeCloseTo((4 / M) * 1.25, 12);
    const unknown = resolveRates('claude-newthing-9', { newthing: { input: 7, output: 30 } });
    expect(unknown.estimated).toBe(false);
    expect(unknown.rates.input).toBeCloseTo(7 / M, 12);
  });
});

describe('computeMessageCost', () => {
  it('prices all four buckets with the 5m/1h split', () => {
    const c = computeMessageCost('claude-opus-4-8', {
      input_tokens: 1000,
      output_tokens: 2000,
      cache_read_input_tokens: 100_000,
      cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 20_000 },
    });
    expect(c.inputUsd).toBeCloseTo(1000 * (5 / M), 10);
    expect(c.outputUsd).toBeCloseTo(2000 * (25 / M), 10);
    expect(c.cacheReadUsd).toBeCloseTo(100_000 * (5 / M) * 0.1, 10);
    expect(c.cacheWriteUsd).toBeCloseTo(10_000 * (5 / M) * 1.25 + 20_000 * (5 / M) * 2, 10);
    expect(c.usd).toBeCloseTo(c.inputUsd + c.outputUsd + c.cacheReadUsd + c.cacheWriteUsd, 10);
    expect(c.estimated).toBe(false);
  });

  it('falls back to 1.25x for aggregate cache_creation_input_tokens', () => {
    const c = computeMessageCost('claude-sonnet-5', {
      cache_creation_input_tokens: 8000,
    });
    expect(c.cacheWriteUsd).toBeCloseTo(8000 * (3 / M) * 1.25, 10);
  });

  it('empty usage costs zero', () => {
    expect(computeMessageCost('claude-opus-4-8', {}).usd).toBe(0);
  });
});

describe('splitCacheWriteTokens', () => {
  it('uses the split when present, else aggregate as 5m', () => {
    expect(
      splitCacheWriteTokens({ cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 } }),
    ).toEqual({ t5m: 3, t1h: 4 });
    expect(splitCacheWriteTokens({ cache_creation_input_tokens: 9 })).toEqual({ t5m: 9, t1h: 0 });
    expect(splitCacheWriteTokens({})).toEqual({ t5m: 0, t1h: 0 });
  });
});

describe('parsePricingOverrides', () => {
  it('parses valid JSON, rejects garbage', () => {
    expect(parsePricingOverrides('{"opus-4-8":{"input":4}}')).toEqual({ 'opus-4-8': { input: 4 } });
    expect(parsePricingOverrides('not json')).toBeUndefined();
    expect(parsePricingOverrides(null)).toBeUndefined();
    expect(parsePricingOverrides('[1,2]')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/pricing.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/pricing`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/pricing.ts`:

```ts
// Pure pricing engine — the single source of truth for token→USD conversion.
// Imported by the renderer (per-message footer) and by electron main-process
// services (session cost, usage dashboard, cost history). Must stay free of
// Node and DOM APIs so it type-checks under both tsconfigs.
//
// Rates: docs/superpowers/specs/2026-07-17-session-cost-tracking-design.md §1.

export interface ModelRates {
  /** USD per single token (per-MTok sticker price / 1e6). */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** User-supplied rate override, in USD per MTok (matches published pricing). */
export interface PricingOverride {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

/** Keyed by model-id substring pattern, e.g. { "opus-4-8": { input: 4 } }. */
export type PricingOverrides = Record<string, PricingOverride>;

export interface UsageTokens {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

export interface MessageCost {
  usd: number;
  /** True when the model matched no table entry and no override. */
  estimated: boolean;
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
}

const MTOK = 1_000_000;

// Ordered most-specific-first; first `model.includes(pattern)` match wins.
const RATE_TABLE: Array<{ pattern: string; inputPerM: number; outputPerM: number }> = [
  { pattern: 'fable', inputPerM: 10, outputPerM: 50 },
  { pattern: 'mythos', inputPerM: 10, outputPerM: 50 },
  { pattern: 'opus-4-5', inputPerM: 5, outputPerM: 25 },
  { pattern: 'opus-4-6', inputPerM: 5, outputPerM: 25 },
  { pattern: 'opus-4-7', inputPerM: 5, outputPerM: 25 },
  { pattern: 'opus-4-8', inputPerM: 5, outputPerM: 25 },
  { pattern: 'opus', inputPerM: 15, outputPerM: 75 },
  { pattern: 'haiku-4-5', inputPerM: 1, outputPerM: 5 },
  { pattern: 'haiku', inputPerM: 0.25, outputPerM: 1.25 },
  { pattern: 'sonnet', inputPerM: 3, outputPerM: 15 },
];

const DEFAULT_RATES = { inputPerM: 3, outputPerM: 15 }; // sonnet-tier fallback

function baseRates(inputPerM: number, outputPerM: number): ModelRates {
  const input = inputPerM / MTOK;
  return {
    input,
    output: outputPerM / MTOK,
    cacheRead: input * 0.1,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
  };
}

export function resolveRates(
  model: string,
  overrides?: PricingOverrides,
): { rates: ModelRates; estimated: boolean } {
  const m = (model || '').toLowerCase();
  const entry = RATE_TABLE.find((e) => m.includes(e.pattern));
  let rates = entry
    ? baseRates(entry.inputPerM, entry.outputPerM)
    : baseRates(DEFAULT_RATES.inputPerM, DEFAULT_RATES.outputPerM);
  let estimated = !entry;

  if (overrides) {
    const key = Object.keys(overrides)
      .sort((a, b) => b.length - a.length)
      .find((k) => k.length > 0 && m.includes(k.toLowerCase()));
    if (key) {
      const o = overrides[key];
      const input = o.input != null ? o.input / MTOK : rates.input;
      rates = {
        input,
        output: o.output != null ? o.output / MTOK : rates.output,
        cacheRead: o.cacheRead != null ? o.cacheRead / MTOK : input * 0.1,
        cacheWrite5m: o.cacheWrite5m != null ? o.cacheWrite5m / MTOK : input * 1.25,
        cacheWrite1h: o.cacheWrite1h != null ? o.cacheWrite1h / MTOK : input * 2,
      };
      estimated = false;
    }
  }
  return { rates, estimated };
}

export function splitCacheWriteTokens(usage: UsageTokens): { t5m: number; t1h: number } {
  const split = usage.cache_creation;
  if (split && (split.ephemeral_5m_input_tokens != null || split.ephemeral_1h_input_tokens != null)) {
    return { t5m: split.ephemeral_5m_input_tokens ?? 0, t1h: split.ephemeral_1h_input_tokens ?? 0 };
  }
  return { t5m: usage.cache_creation_input_tokens ?? 0, t1h: 0 };
}

export function computeMessageCost(
  model: string,
  usage: UsageTokens,
  overrides?: PricingOverrides,
): MessageCost {
  const { rates, estimated } = resolveRates(model, overrides);
  const inputUsd = (usage.input_tokens ?? 0) * rates.input;
  const outputUsd = (usage.output_tokens ?? 0) * rates.output;
  const cacheReadUsd = (usage.cache_read_input_tokens ?? 0) * rates.cacheRead;
  const { t5m, t1h } = splitCacheWriteTokens(usage);
  const cacheWriteUsd = t5m * rates.cacheWrite5m + t1h * rates.cacheWrite1h;
  return {
    usd: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd,
    estimated,
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
  };
}

/** Safe parse for the `pricing_overrides` app setting (JSON object or bust). */
export function parsePricingOverrides(
  json: string | null | undefined,
): PricingOverrides | undefined {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as PricingOverrides;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/pricing.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/lib/pricing.ts electron/__tests__/pricing.test.ts
git commit -m "feat(cost): shared pricing module with cache-aware, override-capable rates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: JSONL usage extractor with requestId dedup

**Files:**
- Create: `electron/services/cost/usage-extract.ts`
- Test: `electron/__tests__/cost-usage-extract.test.ts`

**Interfaces:**
- Consumes: `UsageTokens` from `../../../src/lib/pricing`.
- Produces:
  - `interface ExtractedUsageRow { key: string; model: string; timestamp: string; usage: UsageTokens }`
  - `extractDedupedUsage(content: string): ExtractedUsageRow[]` — one row per API request (deduped), insertion-ordered, last occurrence wins.

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/cost-usage-extract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractDedupedUsage } from '../services/cost/usage-extract';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const usageA = { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 50 };

describe('extractDedupedUsage', () => {
  it('extracts assistant lines with usage, skips others and garbage', () => {
    const content = [
      line({ type: 'user', message: {} }),
      'not json at all',
      line({ type: 'assistant', requestId: 'req_1', timestamp: '2026-07-17T01:02:03.000Z', message: { id: 'msg_1', model: 'claude-opus-4-8', usage: usageA } }),
      line({ type: 'assistant', message: { id: 'msg_nousage', model: 'claude-opus-4-8' } }),
    ].join('\n');
    const rows = extractDedupedUsage(content);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      key: 'req_1',
      model: 'claude-opus-4-8',
      timestamp: '2026-07-17T01:02:03.000Z',
      usage: usageA,
    });
  });

  it('dedups multi-block messages sharing requestId — last occurrence wins', () => {
    const content = [
      line({ type: 'assistant', requestId: 'req_1', timestamp: '2026-07-17T01:00:00Z', message: { id: 'msg_1', model: 'claude-opus-4-8', usage: { input_tokens: 2, output_tokens: 10 } } }),
      line({ type: 'assistant', requestId: 'req_1', timestamp: '2026-07-17T01:00:01Z', message: { id: 'msg_1', model: 'claude-opus-4-8', usage: { input_tokens: 2, output_tokens: 99 } } }),
      line({ type: 'assistant', requestId: 'req_2', timestamp: '2026-07-17T01:00:02Z', message: { id: 'msg_2', model: 'claude-opus-4-8', usage: usageA } }),
    ].join('\n');
    const rows = extractDedupedUsage(content);
    expect(rows).toHaveLength(2);
    expect(rows[0].usage.output_tokens).toBe(99);
    expect(rows[1].key).toBe('req_2');
  });

  it('falls back to message.id then per-line key', () => {
    const content = [
      line({ type: 'assistant', message: { id: 'msg_only', model: 'claude-sonnet-5', usage: usageA } }),
      line({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: usageA } }),
      line({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: usageA } }),
    ].join('\n');
    const rows = extractDedupedUsage(content);
    expect(rows).toHaveLength(3);
    expect(rows[0].key).toBe('msg_only');
    expect(rows[1].key).not.toBe(rows[2].key);
  });

  it('missing model becomes "unknown", missing timestamp empty string', () => {
    const rows = extractDedupedUsage(line({ type: 'assistant', message: { id: 'm', usage: usageA } }));
    expect(rows[0].model).toBe('unknown');
    expect(rows[0].timestamp).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/cost-usage-extract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `electron/services/cost/usage-extract.ts`:

```ts
// Cost module — deduped usage extraction from a session JSONL.
//
// The CLI writes one JSONL line per assistant content block; lines belonging
// to the same API request share `requestId` (and `message.id`) and carry the
// SAME usage object, so summing raw lines double-counts multi-block messages.
// This extractor keys rows by requestId (fallback message.id, fallback line
// index) with last-occurrence-wins semantics, yielding exactly one usage row
// per billed API request.

import type { UsageTokens } from '../../../src/lib/pricing';

export interface ExtractedUsageRow {
  key: string;
  model: string;
  timestamp: string;
  usage: UsageTokens;
}

export function extractDedupedUsage(content: string): ExtractedUsageRow[] {
  const map = new Map<string, ExtractedUsageRow>();
  let lineNo = 0;
  for (const rawLine of content.split('\n')) {
    lineNo += 1;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const obj = parsed as {
      type?: unknown;
      requestId?: unknown;
      timestamp?: unknown;
      message?: { id?: unknown; model?: unknown; usage?: UsageTokens };
    };
    if (obj.type !== 'assistant') continue;
    const usage = obj.message?.usage;
    if (!usage) continue;
    const key =
      (typeof obj.requestId === 'string' && obj.requestId) ||
      (typeof obj.message?.id === 'string' && obj.message.id) ||
      `line:${lineNo}`;
    // Delete-then-set so a re-observed key moves to the end (last wins, and
    // iteration order stays chronological with respect to final observations).
    if (map.has(key)) map.delete(key);
    map.set(key, {
      key,
      model: typeof obj.message?.model === 'string' && obj.message.model ? obj.message.model : 'unknown',
      timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : '',
      usage,
    });
  }
  return [...map.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/cost-usage-extract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/cost/usage-extract.ts electron/__tests__/cost-usage-extract.test.ts
git commit -m "feat(cost): deduped JSONL usage extractor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Pure per-session cost computer

**Files:**
- Create: `electron/services/cost/session-cost-core.ts`
- Test: `electron/__tests__/cost-session-core.test.ts`

**Interfaces:**
- Consumes: `computeMessageCost`, `splitCacheWriteTokens`, `PricingOverrides` from pricing; `extractDedupedUsage` from Task 2.
- Produces:
  - `interface SessionCostSnapshot { totalUsd: number; estimated: boolean; breakdown: { inputUsd: number; outputUsd: number; cacheReadUsd: number; cacheWriteUsd: number }; subagentUsd: number; byModel: Array<{ model: string; usd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } }`
  - `interface SessionCostDailyRow { session_id: string; date: string; model: string; account_name: string; config_dir: string; project_path: string | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_5m_tokens: number; cache_write_1h_tokens: number; cost_usd: number; is_estimated: number }`
  - `computeSessionCost(args: { sessionContent: string; subagentContents: string[]; sessionId: string; accountName: string; configDir: string; projectPath: string | null; overrides?: PricingOverrides }): { snapshot: SessionCostSnapshot; dailyRows: SessionCostDailyRow[] }`

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/cost-session-core.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeSessionCost } from '../services/cost/session-cost-core';

const M = 1_000_000;
const line = (obj: unknown) => JSON.stringify(obj);

function assistantLine(req: string, ts: string, model: string, usage: unknown): string {
  return line({ type: 'assistant', requestId: req, timestamp: ts, message: { id: `m_${req}`, model, usage } });
}

const baseArgs = {
  sessionId: 'sess1',
  accountName: 'Work',
  configDir: '/cfg',
  projectPath: '/Users/me/proj',
};

describe('computeSessionCost', () => {
  it('totals main-session usage into snapshot and daily rows', () => {
    const sessionContent = [
      assistantLine('r1', '2026-07-16T23:59:00Z', 'claude-opus-4-8', { input_tokens: 10, output_tokens: 100 }),
      assistantLine('r2', '2026-07-17T00:01:00Z', 'claude-opus-4-8', { input_tokens: 20, output_tokens: 200, cache_read_input_tokens: 1000 }),
    ].join('\n');
    const { snapshot, dailyRows } = computeSessionCost({ ...baseArgs, sessionContent, subagentContents: [] });

    const expectedOut = 300 * (25 / M);
    const expectedIn = 30 * (5 / M);
    const expectedCacheRead = 1000 * (5 / M) * 0.1;
    expect(snapshot.totalUsd).toBeCloseTo(expectedIn + expectedOut + expectedCacheRead, 10);
    expect(snapshot.breakdown.inputUsd).toBeCloseTo(expectedIn, 10);
    expect(snapshot.subagentUsd).toBe(0);
    expect(snapshot.estimated).toBe(false);
    expect(snapshot.tokens).toEqual({ input: 30, output: 300, cacheRead: 1000, cacheWrite: 0 });
    expect(snapshot.byModel).toHaveLength(1);
    expect(snapshot.byModel[0].model).toBe('claude-opus-4-8');

    // Two UTC dates -> two rows
    expect(dailyRows).toHaveLength(2);
    const dates = dailyRows.map((r) => r.date).sort();
    expect(dates).toEqual(['2026-07-16', '2026-07-17']);
    expect(dailyRows[0].session_id).toBe('sess1');
    expect(dailyRows[0].account_name).toBe('Work');
  });

  it('includes subagent usage in total, subagentUsd, and daily rows', () => {
    const sessionContent = assistantLine('r1', '2026-07-17T01:00:00Z', 'claude-opus-4-8', { output_tokens: 100 });
    const sub = assistantLine('r_sub', '2026-07-17T01:05:00Z', 'claude-haiku-4-5', { output_tokens: 1000 });
    const { snapshot, dailyRows } = computeSessionCost({ ...baseArgs, sessionContent, subagentContents: [sub] });
    const mainUsd = 100 * (25 / M);
    const subUsd = 1000 * (5 / M);
    expect(snapshot.totalUsd).toBeCloseTo(mainUsd + subUsd, 10);
    expect(snapshot.subagentUsd).toBeCloseTo(subUsd, 10);
    expect(snapshot.byModel.map((b) => b.model).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-8']);
    expect(dailyRows).toHaveLength(2); // same date, two models
  });

  it('flags estimated on unknown model and in affected daily rows', () => {
    const sessionContent = assistantLine('r1', '2026-07-17T01:00:00Z', 'claude-mystery-model', { output_tokens: 10 });
    const { snapshot, dailyRows } = computeSessionCost({ ...baseArgs, sessionContent, subagentContents: [] });
    expect(snapshot.estimated).toBe(true);
    expect(dailyRows[0].is_estimated).toBe(1);
  });

  it('rows without timestamps count toward snapshot but not daily rows', () => {
    const sessionContent = line({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-4-8', usage: { output_tokens: 10 } } });
    const { snapshot, dailyRows } = computeSessionCost({ ...baseArgs, sessionContent, subagentContents: [] });
    expect(snapshot.totalUsd).toBeGreaterThan(0);
    expect(dailyRows).toHaveLength(0);
  });

  it('splits cache-write tokens 5m/1h into daily row columns', () => {
    const sessionContent = assistantLine('r1', '2026-07-17T01:00:00Z', 'claude-opus-4-8', {
      cache_creation: { ephemeral_5m_input_tokens: 111, ephemeral_1h_input_tokens: 222 },
    });
    const { dailyRows } = computeSessionCost({ ...baseArgs, sessionContent, subagentContents: [] });
    expect(dailyRows[0].cache_write_5m_tokens).toBe(111);
    expect(dailyRows[0].cache_write_1h_tokens).toBe(222);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/cost-session-core.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `electron/services/cost/session-cost-core.ts`:

```ts
// Cost module — pure per-session cost computation.
//
// Input: raw contents of one session's main JSONL plus its subagent JSONLs.
// Output: a live snapshot (drives the header CostWidget) and daily rows for
// the session_cost_daily table (drives the Costs history view). Pure so the
// live watcher and the backfill sweep share one implementation and tests need
// no filesystem.

import {
  computeMessageCost,
  splitCacheWriteTokens,
  type PricingOverrides,
} from '../../../src/lib/pricing';
import { extractDedupedUsage, type ExtractedUsageRow } from './usage-extract';

export interface SessionCostSnapshot {
  totalUsd: number;
  estimated: boolean;
  breakdown: { inputUsd: number; outputUsd: number; cacheReadUsd: number; cacheWriteUsd: number };
  subagentUsd: number;
  byModel: Array<{
    model: string;
    usd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface SessionCostDailyRow {
  session_id: string;
  date: string;
  model: string;
  account_name: string;
  config_dir: string;
  project_path: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  cost_usd: number;
  is_estimated: number;
}

export interface ComputeSessionCostArgs {
  sessionContent: string;
  subagentContents: string[];
  sessionId: string;
  accountName: string;
  configDir: string;
  projectPath: string | null;
  overrides?: PricingOverrides;
}

export function computeSessionCost(args: ComputeSessionCostArgs): {
  snapshot: SessionCostSnapshot;
  dailyRows: SessionCostDailyRow[];
} {
  const snapshot: SessionCostSnapshot = {
    totalUsd: 0,
    estimated: false,
    breakdown: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0 },
    subagentUsd: 0,
    byModel: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const byModel = new Map<string, SessionCostSnapshot['byModel'][number]>();
  const daily = new Map<string, SessionCostDailyRow>();

  const ingest = (rows: ExtractedUsageRow[], isSubagent: boolean): void => {
    for (const row of rows) {
      const cost = computeMessageCost(row.model, row.usage, args.overrides);
      const { t5m, t1h } = splitCacheWriteTokens(row.usage);
      const input = row.usage.input_tokens ?? 0;
      const output = row.usage.output_tokens ?? 0;
      const cacheRead = row.usage.cache_read_input_tokens ?? 0;

      snapshot.totalUsd += cost.usd;
      snapshot.estimated = snapshot.estimated || cost.estimated;
      snapshot.breakdown.inputUsd += cost.inputUsd;
      snapshot.breakdown.outputUsd += cost.outputUsd;
      snapshot.breakdown.cacheReadUsd += cost.cacheReadUsd;
      snapshot.breakdown.cacheWriteUsd += cost.cacheWriteUsd;
      if (isSubagent) snapshot.subagentUsd += cost.usd;
      snapshot.tokens.input += input;
      snapshot.tokens.output += output;
      snapshot.tokens.cacheRead += cacheRead;
      snapshot.tokens.cacheWrite += t5m + t1h;

      let m = byModel.get(row.model);
      if (!m) {
        m = { model: row.model, usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        byModel.set(row.model, m);
      }
      m.usd += cost.usd;
      m.inputTokens += input;
      m.outputTokens += output;
      m.cacheReadTokens += cacheRead;
      m.cacheWriteTokens += t5m + t1h;

      // Daily bucket — UTC date from the Z-suffixed ISO timestamp. Rows with
      // no timestamp still count toward the live snapshot but cannot be
      // bucketed into history.
      const date = row.timestamp ? row.timestamp.slice(0, 10) : '';
      if (date.length === 10) {
        const key = `${date}|${row.model}`;
        let d = daily.get(key);
        if (!d) {
          d = {
            session_id: args.sessionId,
            date,
            model: row.model,
            account_name: args.accountName,
            config_dir: args.configDir,
            project_path: args.projectPath,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            cost_usd: 0,
            is_estimated: 0,
          };
          daily.set(key, d);
        }
        d.input_tokens += input;
        d.output_tokens += output;
        d.cache_read_tokens += cacheRead;
        d.cache_write_5m_tokens += t5m;
        d.cache_write_1h_tokens += t1h;
        d.cost_usd += cost.usd;
        if (cost.estimated) d.is_estimated = 1;
      }
    }
  };

  ingest(extractDedupedUsage(args.sessionContent), false);
  for (const content of args.subagentContents) {
    ingest(extractDedupedUsage(content), true);
  }

  snapshot.byModel = [...byModel.values()].sort((a, b) => b.usd - a.usd);
  return { snapshot, dailyRows: [...daily.values()] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/cost-session-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/cost/session-cost-core.ts electron/__tests__/cost-session-core.test.ts
git commit -m "feat(cost): pure per-session cost computation with daily bucketing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: DB migration + cost-history service (upsert, query, backfill)

**Files:**
- Modify: `electron/services/database.ts` — append one migration to the `migrations` array (version = current max + 1; at planning time the tail was 11, so 12 — **verify the array tail before writing**).
- Create: `electron/services/cost/cost-history.ts`
- Test: `electron/__tests__/cost-history.test.ts`

**Interfaces:**
- Consumes: `Database` from `../database` (has `.raw` BetterSqlite3 handle, `.getSetting`); `computeSessionCost`, `SessionCostDailyRow` from Task 3; `parsePricingOverrides` from pricing; `encodeProjectKey` from `../sessions/summary-query`.
- Produces:
  - `interface CostFs { readFile(p: string): string | null; listDir(p: string): Array<{ name: string; isDirectory: boolean }> }` (exported; default impl wraps `node:fs`, swallowing errors to `null`/`[]`)
  - `interface CostHistoryFilters { startDate?: string; endDate?: string; accountName?: string; projectPath?: string; model?: string }`
  - `interface CostHistoryPeriod { period: string; cost_usd: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; is_estimated: number }`
  - `interface CostSessionRow { session_id: string; account_name: string; project_path: string | null; first_date: string; last_date: string; cost_usd: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }`
  - `interface AccountLike { name: string; config_dir: string }`
  - `createCostHistoryService(db: Database, fsDeps?: CostFs): CostHistoryService` where `CostHistoryService` = `{ replaceSession(sessionId: string, rows: SessionCostDailyRow[]): void; aggregate(filters: CostHistoryFilters, groupBy: 'day' | 'week' | 'month'): CostHistoryPeriod[]; sessions(filters: CostHistoryFilters): CostSessionRow[]; backfill(accounts: AccountLike[]): { sessionsScanned: number } }`

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/cost-history.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createCostHistoryService, type CostFs } from '../services/cost/cost-history';
import type { SessionCostDailyRow } from '../services/cost/session-cost-core';

function row(partial: Partial<SessionCostDailyRow>): SessionCostDailyRow {
  return {
    session_id: 's1',
    date: '2026-07-17',
    model: 'claude-opus-4-8',
    account_name: 'Work',
    config_dir: '/cfg',
    project_path: '/Users/me/proj',
    input_tokens: 10,
    output_tokens: 100,
    cache_read_tokens: 0,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cost_usd: 1.5,
    is_estimated: 0,
    ...partial,
  };
}

describe('cost-history', () => {
  let db: Database;
  beforeEach(() => { db = createDatabase(':memory:'); });
  afterEach(() => { db.close(); });

  it('migration creates session_cost_daily', () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_cost_daily'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('replaceSession is idempotent and removes stale rows', () => {
    const svc = createCostHistoryService(db);
    svc.replaceSession('s1', [row({ date: '2026-07-16' }), row({ date: '2026-07-17' })]);
    svc.replaceSession('s1', [row({ date: '2026-07-17', cost_usd: 2.0 })]);
    const all = db.raw.prepare('SELECT * FROM session_cost_daily').all() as SessionCostDailyRow[];
    expect(all).toHaveLength(1);
    expect(all[0].cost_usd).toBeCloseTo(2.0, 10);
  });

  it('aggregate groups by day/month and applies filters', () => {
    const svc = createCostHistoryService(db);
    svc.replaceSession('s1', [row({ date: '2026-06-30', cost_usd: 1 })]);
    svc.replaceSession('s2', [
      row({ session_id: 's2', date: '2026-07-01', cost_usd: 2 }),
      row({ session_id: 's2', date: '2026-07-02', cost_usd: 4, account_name: 'Personal' }),
    ]);
    const months = svc.aggregate({}, 'month');
    expect(months.map((m) => m.period)).toEqual(['2026-06', '2026-07']);
    expect(months[1].cost_usd).toBeCloseTo(6, 10);

    const filtered = svc.aggregate({ accountName: 'Work', startDate: '2026-07-01' }, 'day');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].period).toBe('2026-07-01');
  });

  it('sessions rolls up per session ordered by cost', () => {
    const svc = createCostHistoryService(db);
    svc.replaceSession('cheap', [row({ session_id: 'cheap', cost_usd: 1 })]);
    svc.replaceSession('spendy', [
      row({ session_id: 'spendy', date: '2026-07-16', cost_usd: 5 }),
      row({ session_id: 'spendy', date: '2026-07-17', cost_usd: 5 }),
    ]);
    const sessions = svc.sessions({});
    expect(sessions[0].session_id).toBe('spendy');
    expect(sessions[0].cost_usd).toBeCloseTo(10, 10);
    expect(sessions[0].first_date).toBe('2026-07-16');
    expect(sessions[0].last_date).toBe('2026-07-17');
  });

  it('backfill walks config dirs incl. subagents and upserts', () => {
    const CFG = '/cfg';
    const PROJ_DIR = path.join(CFG, 'projects', '-Users-me-proj');
    const sessionLine = JSON.stringify({
      type: 'assistant', requestId: 'r1', timestamp: '2026-07-17T01:00:00Z', cwd: '/Users/me/proj',
      message: { id: 'm1', model: 'claude-opus-4-8', usage: { output_tokens: 1000 } },
    });
    const subLine = JSON.stringify({
      type: 'assistant', requestId: 'r_sub', timestamp: '2026-07-17T01:05:00Z',
      message: { id: 'm2', model: 'claude-haiku-4-5', usage: { output_tokens: 500 } },
    });
    const files: Record<string, string> = {
      [path.join(PROJ_DIR, 'sessA.jsonl')]: sessionLine,
      [path.join(PROJ_DIR, 'sessA', 'subagents', 'agent-x1.jsonl')]: subLine,
    };
    const dirs: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
      [path.join(CFG, 'projects')]: [{ name: '-Users-me-proj', isDirectory: true }],
      [PROJ_DIR]: [
        { name: 'sessA.jsonl', isDirectory: false },
        { name: 'sessA', isDirectory: true },
      ],
      [path.join(PROJ_DIR, 'sessA', 'subagents')]: [{ name: 'agent-x1.jsonl', isDirectory: false }],
    };
    const fakeFs: CostFs = {
      readFile: (p) => files[p] ?? null,
      listDir: (p) => dirs[p] ?? [],
    };
    const svc = createCostHistoryService(db, fakeFs);
    const result = svc.backfill([{ name: 'Work', config_dir: CFG }]);
    expect(result.sessionsScanned).toBe(1);
    const rows = db.raw.prepare('SELECT * FROM session_cost_daily ORDER BY model').all() as SessionCostDailyRow[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.model)).toEqual(['claude-haiku-4-5', 'claude-opus-4-8']);
    expect(rows[1].project_path).toBe('/Users/me/proj');
    expect(rows[1].session_id).toBe('sessA');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/cost-history.test.ts`
Expected: FAIL — no table / module not found.

- [ ] **Step 3: Add the migration**

In `electron/services/database.ts`, append to the `migrations` array (before the closing `];`), using the next free version number:

```ts
  {
    version: 12, // ← verify: current max version in this array + 1
    description: 'Add session_cost_daily table for durable cost history',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_cost_daily (
          session_id            TEXT NOT NULL,
          date                  TEXT NOT NULL,
          model                 TEXT NOT NULL,
          account_name          TEXT NOT NULL,
          config_dir            TEXT NOT NULL,
          project_path          TEXT,
          input_tokens          INTEGER NOT NULL DEFAULT 0,
          output_tokens         INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
          cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd              REAL NOT NULL,
          is_estimated          INTEGER NOT NULL DEFAULT 0,
          updated_at            TEXT NOT NULL,
          PRIMARY KEY (session_id, date, model)
        );
        CREATE INDEX IF NOT EXISTS idx_session_cost_daily_date ON session_cost_daily(date);
        CREATE INDEX IF NOT EXISTS idx_session_cost_daily_account ON session_cost_daily(account_name, date);
      `);
    },
  },
```

- [ ] **Step 4: Write the cost-history service**

Create `electron/services/cost/cost-history.ts`:

```ts
// Cost module — durable cost history in SQLite.
//
// Rows survive the CLI's transcript pruning (cleanupPeriodDays); the table is
// the source for the Costs view. replaceSession keeps writes idempotent
// (delete-then-insert per session inside one transaction). backfill() walks
// every account config dir's surviving JSONLs — including sessions run
// outside OmniFex — so monthly totals can reconcile against Anthropic's
// console.

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../database';
import { parsePricingOverrides } from '../../../src/lib/pricing';
import { computeSessionCost, type SessionCostDailyRow } from './session-cost-core';

export interface CostFs {
  readFile(p: string): string | null;
  listDir(p: string): Array<{ name: string; isDirectory: boolean }>;
}

export const nodeCostFs: CostFs = {
  readFile(p: string): string | null {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  listDir(p: string): Array<{ name: string; isDirectory: boolean }> {
    try {
      return fs
        .readdirSync(p, { withFileTypes: true })
        .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return [];
    }
  },
};

export interface CostHistoryFilters {
  startDate?: string;
  endDate?: string;
  accountName?: string;
  projectPath?: string;
  model?: string;
}

export interface CostHistoryPeriod {
  period: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  is_estimated: number;
}

export interface CostSessionRow {
  session_id: string;
  account_name: string;
  project_path: string | null;
  first_date: string;
  last_date: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface AccountLike {
  name: string;
  config_dir: string;
}

export interface CostHistoryService {
  replaceSession(sessionId: string, rows: SessionCostDailyRow[]): void;
  aggregate(filters: CostHistoryFilters, groupBy: 'day' | 'week' | 'month'): CostHistoryPeriod[];
  sessions(filters: CostHistoryFilters): CostSessionRow[];
  backfill(accounts: AccountLike[]): { sessionsScanned: number };
}

function whereClause(filters: CostHistoryFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.startDate) { clauses.push('date >= ?'); params.push(filters.startDate); }
  if (filters.endDate) { clauses.push('date <= ?'); params.push(filters.endDate); }
  if (filters.accountName) { clauses.push('account_name = ?'); params.push(filters.accountName); }
  if (filters.projectPath) { clauses.push('project_path = ?'); params.push(filters.projectPath); }
  if (filters.model) { clauses.push('model = ?'); params.push(filters.model); }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const PERIOD_EXPR: Record<'day' | 'week' | 'month', string> = {
  day: 'date',
  week: "strftime('%Y-W%W', date)",
  month: 'substr(date, 1, 7)',
};

/** Recover the real project path from `cwd` on early JSONL lines; the dir
 *  name's `/`→`-` encoding is lossy. Mirrors usage.ts's recovery approach. */
function recoverProjectPath(content: string, dirName: string): string {
  const lines = content.split('\n', 50);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as { cwd?: unknown };
      if (typeof parsed.cwd === 'string' && parsed.cwd.startsWith('/')) return parsed.cwd;
    } catch {
      continue;
    }
  }
  return dirName.replace(/-/g, '/');
}

export function createCostHistoryService(db: Database, fsDeps: CostFs = nodeCostFs): CostHistoryService {
  const insertStmt = db.raw.prepare(`
    INSERT INTO session_cost_daily (
      session_id, date, model, account_name, config_dir, project_path,
      input_tokens, output_tokens, cache_read_tokens,
      cache_write_5m_tokens, cache_write_1h_tokens,
      cost_usd, is_estimated, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteStmt = db.raw.prepare('DELETE FROM session_cost_daily WHERE session_id = ?');

  const replaceSession = db.raw.transaction((sessionId: string, rows: SessionCostDailyRow[]) => {
    deleteStmt.run(sessionId);
    const now = new Date().toISOString();
    for (const r of rows) {
      insertStmt.run(
        r.session_id, r.date, r.model, r.account_name, r.config_dir, r.project_path,
        r.input_tokens, r.output_tokens, r.cache_read_tokens,
        r.cache_write_5m_tokens, r.cache_write_1h_tokens,
        r.cost_usd, r.is_estimated, now,
      );
    }
  });

  function aggregate(filters: CostHistoryFilters, groupBy: 'day' | 'week' | 'month'): CostHistoryPeriod[] {
    const { sql, params } = whereClause(filters);
    return db.raw
      .prepare(`
        SELECT ${PERIOD_EXPR[groupBy]} AS period,
               SUM(cost_usd) AS cost_usd,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens,
               MAX(is_estimated) AS is_estimated
        FROM session_cost_daily ${sql}
        GROUP BY period ORDER BY period
      `)
      .all(...params) as CostHistoryPeriod[];
  }

  function sessions(filters: CostHistoryFilters): CostSessionRow[] {
    const { sql, params } = whereClause(filters);
    return db.raw
      .prepare(`
        SELECT session_id, account_name, project_path,
               MIN(date) AS first_date, MAX(date) AS last_date,
               SUM(cost_usd) AS cost_usd,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens
        FROM session_cost_daily ${sql}
        GROUP BY session_id ORDER BY cost_usd DESC LIMIT 500
      `)
      .all(...params) as CostSessionRow[];
  }

  function backfill(accounts: AccountLike[]): { sessionsScanned: number } {
    const overrides = parsePricingOverrides(db.getSetting('pricing_overrides'));
    let sessionsScanned = 0;
    for (const account of accounts) {
      const projectsDir = path.join(account.config_dir, 'projects');
      for (const projectEntry of fsDeps.listDir(projectsDir)) {
        if (!projectEntry.isDirectory) continue;
        const projectDir = path.join(projectsDir, projectEntry.name);
        const entries = fsDeps.listDir(projectDir);
        for (const entry of entries) {
          if (entry.isDirectory || !entry.name.endsWith('.jsonl')) continue;
          const sessionId = entry.name.slice(0, -'.jsonl'.length);
          const sessionContent = fsDeps.readFile(path.join(projectDir, entry.name));
          if (sessionContent === null) continue;
          const subagentsDir = path.join(projectDir, sessionId, 'subagents');
          const subagentContents = fsDeps
            .listDir(subagentsDir)
            .filter((e) => !e.isDirectory && e.name.startsWith('agent-') && e.name.endsWith('.jsonl'))
            .map((e) => fsDeps.readFile(path.join(subagentsDir, e.name)))
            .filter((c): c is string => c !== null);
          const projectPath = recoverProjectPath(sessionContent, projectEntry.name);
          const { dailyRows } = computeSessionCost({
            sessionContent,
            subagentContents,
            sessionId,
            accountName: account.name,
            configDir: account.config_dir,
            projectPath,
            overrides,
          });
          replaceSession(sessionId, dailyRows);
          sessionsScanned += 1;
        }
      }
    }
    return { sessionsScanned };
  }

  return {
    replaceSession: (sessionId, rows) => { replaceSession(sessionId, rows); },
    aggregate,
    sessions,
    backfill,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/cost-history.test.ts electron/__tests__/database.test.ts`
Expected: PASS (including existing database tests — the new migration must not break them).

- [ ] **Step 6: Commit**

```bash
git add electron/services/database.ts electron/services/cost/cost-history.ts electron/__tests__/cost-history.test.ts
git commit -m "feat(cost): session_cost_daily migration + cost-history service with backfill

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Live session-cost watcher service

**Files:**
- Create: `electron/services/cost/session-cost.ts`
- Test: `electron/__tests__/cost-session-watcher.test.ts`

**Interfaces:**
- Consumes: `computeSessionCost`/`SessionCostSnapshot` (Task 3), `CostHistoryService`, `CostFs` (Task 4), `encodeProjectKey` from `../sessions/summary-query`, `PricingOverrides`.
- Produces:
  - `interface SessionCostArgs { configDir: string; projectPath: string; sessionId: string; accountName: string }`
  - `createSessionCostService(deps: { sendToRenderer: (channel: string, payload: unknown) => void; costHistory: CostHistoryService | null; getOverrides: () => PricingOverrides | undefined; fs?: CostFs; stat?: (p: string) => { mtimeMs: number; size: number } | null; pollMs?: number }): SessionCostService`
  - `SessionCostService = { get(args: SessionCostArgs): SessionCostSnapshot; watch(args: SessionCostArgs): SessionCostSnapshot; unwatch(sessionId: string): void; stopAll(): void }`
  - Event channel: `session-cost:<sessionId>` carrying a `SessionCostSnapshot` (covered by existing `'session-'` prefix allow-list).

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/cost-session-watcher.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { createSessionCostService } from '../services/cost/session-cost';
import type { CostFs } from '../services/cost/cost-history';
import type { SessionCostDailyRow } from '../services/cost/session-cost-core';

const CFG = '/cfg';
const PROJECT = '/Users/me/proj';
const PROJECT_DIR = path.join(CFG, 'projects', '-Users-me-proj');
const SESSION_FILE = path.join(PROJECT_DIR, 'sess1.jsonl');
const SUBAGENTS_DIR = path.join(PROJECT_DIR, 'sess1', 'subagents');

const args = { configDir: CFG, projectPath: PROJECT, sessionId: 'sess1', accountName: 'Work' };

function assistantLine(req: string, out: number): string {
  return JSON.stringify({
    type: 'assistant', requestId: req, timestamp: '2026-07-17T01:00:00Z',
    message: { id: `m_${req}`, model: 'claude-opus-4-8', usage: { output_tokens: out } },
  });
}

function makeWorld(initial: string) {
  const files: Record<string, string> = { [SESSION_FILE]: initial };
  const dirs: Record<string, Array<{ name: string; isDirectory: boolean }>> = { [SUBAGENTS_DIR]: [] };
  const fakeFs: CostFs = {
    readFile: (p) => files[p] ?? null,
    listDir: (p) => dirs[p] ?? [],
  };
  const stat = (p: string) => (p in files ? { mtimeMs: files[p].length, size: files[p].length } : null);
  return { files, dirs, fakeFs, stat };
}

describe('session-cost watcher', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('get() computes a snapshot and upserts history', () => {
    const world = makeWorld(assistantLine('r1', 1000));
    const upserts: Array<{ sessionId: string; rows: SessionCostDailyRow[] }> = [];
    const svc = createSessionCostService({
      sendToRenderer: () => {},
      costHistory: { replaceSession: (sessionId, rows) => upserts.push({ sessionId, rows }) } as never,
      getOverrides: () => undefined,
      fs: world.fakeFs,
      stat: world.stat,
    });
    const snap = svc.get(args);
    expect(snap.totalUsd).toBeCloseTo(1000 * (25 / 1_000_000), 10);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].sessionId).toBe('sess1');
  });

  it('watch() emits on change and stops after unwatch', () => {
    vi.useFakeTimers();
    const world = makeWorld(assistantLine('r1', 1000));
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const svc = createSessionCostService({
      sendToRenderer: (channel, payload) => emitted.push({ channel, payload }),
      costHistory: null,
      getOverrides: () => undefined,
      fs: world.fakeFs,
      stat: world.stat,
      pollMs: 1000,
    });
    svc.watch(args);
    vi.advanceTimersByTime(1100);
    expect(emitted).toHaveLength(0); // no change yet

    world.files[SESSION_FILE] += '\n' + assistantLine('r2', 2000);
    vi.advanceTimersByTime(1100);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].channel).toBe('session-cost:sess1');
    const payload = emitted[0].payload as { totalUsd: number };
    expect(payload.totalUsd).toBeCloseTo(3000 * (25 / 1_000_000), 10);

    svc.unwatch('sess1');
    world.files[SESSION_FILE] += '\n' + assistantLine('r3', 1);
    vi.advanceTimersByTime(2200);
    expect(emitted).toHaveLength(1);
  });

  it('missing session file yields a zero snapshot without throwing', () => {
    const world = makeWorld('');
    delete world.files[SESSION_FILE];
    const svc = createSessionCostService({
      sendToRenderer: () => {},
      costHistory: null,
      getOverrides: () => undefined,
      fs: world.fakeFs,
      stat: world.stat,
    });
    expect(svc.get(args).totalUsd).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/cost-session-watcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `electron/services/cost/session-cost.ts`:

```ts
// Cost module — live per-session cost watcher.
//
// One watcher per watched session. Polls a change signature (main JSONL
// mtime+size, plus the subagents dir listing with per-file sizes) once per
// pollMs; on change it re-reads and recomputes the whole session (full
// re-parse at 1s debounce is well within budget for multi-MB transcripts and
// avoids the offset/dedup bookkeeping an incremental parse would need),
// pushes the snapshot on `session-cost:<sessionId>`, and upserts history.

import path from 'node:path';
import fs from 'node:fs';
import { encodeProjectKey } from '../sessions/summary-query';
import type { PricingOverrides } from '../../../src/lib/pricing';
import { computeSessionCost, type SessionCostSnapshot } from './session-cost-core';
import { nodeCostFs, type CostFs, type CostHistoryService } from './cost-history';

export interface SessionCostArgs {
  configDir: string;
  projectPath: string;
  sessionId: string;
  accountName: string;
}

export interface SessionCostService {
  get(args: SessionCostArgs): SessionCostSnapshot;
  watch(args: SessionCostArgs): SessionCostSnapshot;
  unwatch(sessionId: string): void;
  stopAll(): void;
}

interface SessionCostDeps {
  sendToRenderer: (channel: string, payload: unknown) => void;
  costHistory: CostHistoryService | null;
  getOverrides: () => PricingOverrides | undefined;
  fs?: CostFs;
  stat?: (p: string) => { mtimeMs: number; size: number } | null;
  pollMs?: number;
}

const nodeStat = (p: string): { mtimeMs: number; size: number } | null => {
  try {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
};

export function createSessionCostService(deps: SessionCostDeps): SessionCostService {
  const fsDeps = deps.fs ?? nodeCostFs;
  const stat = deps.stat ?? nodeStat;
  const pollMs = deps.pollMs ?? 1000;
  const watchers = new Map<string, { timer: NodeJS.Timeout; signature: string }>();

  function paths(args: SessionCostArgs) {
    const projectDir = path.join(args.configDir, 'projects', encodeProjectKey(args.projectPath));
    return {
      sessionFile: path.join(projectDir, `${args.sessionId}.jsonl`),
      subagentsDir: path.join(projectDir, args.sessionId, 'subagents'),
    };
  }

  function signature(args: SessionCostArgs): string {
    const { sessionFile, subagentsDir } = paths(args);
    const main = stat(sessionFile);
    const subs = fsDeps
      .listDir(subagentsDir)
      .filter((e) => !e.isDirectory && e.name.endsWith('.jsonl'))
      .map((e) => {
        const s = stat(path.join(subagentsDir, e.name));
        return `${e.name}:${s?.size ?? 0}:${s?.mtimeMs ?? 0}`;
      })
      .sort()
      .join(',');
    return `${main?.size ?? 0}:${main?.mtimeMs ?? 0}|${subs}`;
  }

  function compute(args: SessionCostArgs): SessionCostSnapshot {
    const { sessionFile, subagentsDir } = paths(args);
    const sessionContent = fsDeps.readFile(sessionFile) ?? '';
    const subagentContents = fsDeps
      .listDir(subagentsDir)
      .filter((e) => !e.isDirectory && e.name.startsWith('agent-') && e.name.endsWith('.jsonl'))
      .map((e) => fsDeps.readFile(path.join(subagentsDir, e.name)))
      .filter((c): c is string => c !== null);
    const { snapshot, dailyRows } = computeSessionCost({
      sessionContent,
      subagentContents,
      sessionId: args.sessionId,
      accountName: args.accountName,
      configDir: args.configDir,
      projectPath: args.projectPath,
      overrides: deps.getOverrides(),
    });
    try {
      deps.costHistory?.replaceSession(args.sessionId, dailyRows);
    } catch (err) {
      console.warn('[session-cost] history upsert failed:', err);
    }
    return snapshot;
  }

  function watch(args: SessionCostArgs): SessionCostSnapshot {
    unwatch(args.sessionId);
    const initial = compute(args);
    const state = { timer: null as unknown as NodeJS.Timeout, signature: signature(args) };
    state.timer = setInterval(() => {
      const sig = signature(args);
      if (sig === state.signature) return;
      state.signature = sig;
      const snapshot = compute(args);
      deps.sendToRenderer(`session-cost:${args.sessionId}`, snapshot);
    }, pollMs);
    watchers.set(args.sessionId, state);
    return initial;
  }

  function unwatch(sessionId: string): void {
    const w = watchers.get(sessionId);
    if (w) {
      clearInterval(w.timer);
      watchers.delete(sessionId);
    }
  }

  return {
    get: compute,
    watch,
    unwatch,
    stopAll: () => {
      for (const id of [...watchers.keys()]) unwatch(id);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/cost-session-watcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/cost/session-cost.ts electron/__tests__/cost-session-watcher.test.ts
git commit -m "feat(cost): live session-cost watcher emitting session-cost:<id> events

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: IPC wiring (channels, handlers, main.ts, api.ts) + startup backfill

**Files:**
- Modify: `electron/ipc/channels.ts` — add invoke channels
- Modify: `electron/ipc/handlers.ts` — add `cost` member to `Services` + handler entries
- Modify: `electron/main.ts` — construct services, wire adapters, schedule backfill/sweep
- Modify: `src/lib/api.ts` — types + wrappers
- Test: `electron/__tests__/ipc-channel-contract.test.ts` (extend, if it asserts channel lists — read it first; if it auto-derives, no change needed)

**Interfaces:**
- Consumes: everything from Tasks 4–5.
- Produces (renderer-visible):
  - Invoke channels: `session_cost_get`, `session_cost_watch`, `session_cost_unwatch`, `session_cost_history`, `session_cost_sessions`, `session_cost_rescan`
  - `api.sessionCostWatch(configDir, projectPath, sessionId, accountName): Promise<SessionCostSnapshot | null>`
  - `api.sessionCostUnwatch(sessionId): Promise<null>`
  - `api.sessionCostHistory(filters: { startDate?, endDate?, accountName?, projectPath?, model?, groupBy: 'day'|'week'|'month' }): Promise<CostHistoryPeriod[]>`
  - `api.sessionCostSessions(filters minus groupBy): Promise<CostSessionRow[]>`
  - `api.sessionCostRescan(): Promise<{ sessionsScanned: number } | null>`
  - Re-exported types in api.ts: `SessionCostSnapshot`, `CostHistoryPeriod`, `CostSessionRow`.

- [ ] **Step 1: Add invoke channels**

In `electron/ipc/channels.ts`, add to the `INVOKE_CHANNELS` array (near the other `session_*` entries):

```ts
  'session_cost_get',
  'session_cost_watch',
  'session_cost_unwatch',
  'session_cost_history',
  'session_cost_sessions',
  'session_cost_rescan',
```

- [ ] **Step 2: Add Services member + handlers**

In `electron/ipc/handlers.ts`, add to the `Services` interface:

```ts
  cost?: {
    get(args: { configDir: string; projectPath: string; sessionId: string; accountName: string }): unknown;
    watch(args: { configDir: string; projectPath: string; sessionId: string; accountName: string }): unknown;
    unwatch(sessionId: string): unknown;
    history(filters: Record<string, unknown>): unknown;
    sessions(filters: Record<string, unknown>): unknown;
    rescan(): unknown;
  };
```

Destructure `cost` where the other services are destructured, then add handler entries alongside the other `session_*` handlers:

```ts
    session_cost_get: wrapWith((p: Record<string, unknown>) => cost?.get({
      configDir: (p?.configDir ?? p?.config_dir) as string,
      projectPath: (p?.projectPath ?? p?.project_path) as string,
      sessionId: (p?.sessionId ?? p?.session_id) as string,
      accountName: (p?.accountName ?? p?.account_name) as string,
    }) ?? null),
    session_cost_watch: wrapWith((p: Record<string, unknown>) => cost?.watch({
      configDir: (p?.configDir ?? p?.config_dir) as string,
      projectPath: (p?.projectPath ?? p?.project_path) as string,
      sessionId: (p?.sessionId ?? p?.session_id) as string,
      accountName: (p?.accountName ?? p?.account_name) as string,
    }) ?? null),
    session_cost_unwatch: wrapWith((p: Record<string, unknown>) => {
      cost?.unwatch((p?.sessionId ?? p?.session_id) as string);
      return null;
    }),
    session_cost_history: wrapWith((p: Record<string, unknown>) => cost?.history({
      startDate: p?.startDate ?? p?.start_date,
      endDate: p?.endDate ?? p?.end_date,
      accountName: p?.accountName ?? p?.account_name,
      projectPath: p?.projectPath ?? p?.project_path,
      model: p?.model,
      groupBy: p?.groupBy ?? p?.group_by,
    }) ?? []),
    session_cost_sessions: wrapWith((p: Record<string, unknown>) => cost?.sessions({
      startDate: p?.startDate ?? p?.start_date,
      endDate: p?.endDate ?? p?.end_date,
      accountName: p?.accountName ?? p?.account_name,
      projectPath: p?.projectPath ?? p?.project_path,
      model: p?.model,
    }) ?? []),
    session_cost_rescan: wrapWith(() => cost?.rescan() ?? null),
```

(Match `wrapWith`'s actual signature in the file — if handlers there receive `(p)` untyped, follow the local pattern exactly.)

- [ ] **Step 3: Wire in main.ts**

In `electron/main.ts` (near where `usageService` is constructed at ~line 561):

```ts
import { createCostHistoryService } from './services/cost/cost-history';
import { createSessionCostService } from './services/cost/session-cost';
import { parsePricingOverrides } from '../src/lib/pricing';
```

```ts
  const costHistoryService = createCostHistoryService(db);
  const sessionCostService = createSessionCostService({
    sendToRenderer,
    costHistory: costHistoryService,
    getOverrides: () => parsePricingOverrides(db.getSetting('pricing_overrides')),
  });

  // Backfill history from surviving transcripts shortly after startup, then
  // sweep hourly to catch sessions run outside OmniFex (terminal claude-work).
  setTimeout(() => {
    try {
      const r = costHistoryService.backfill(accountsService.listAccounts());
      console.log(`[cost-history] startup backfill: ${r.sessionsScanned} sessions`);
    } catch (err) {
      console.warn('[cost-history] startup backfill failed:', err);
    }
  }, 30_000);
  setInterval(() => {
    try {
      costHistoryService.backfill(accountsService.listAccounts());
    } catch (err) {
      console.warn('[cost-history] sweep failed:', err);
    }
  }, 60 * 60 * 1000);
```

(`sendToRenderer` — use the same function/mechanism the sessions runtime uses; find how it's passed to `createSessionsService`/git-watcher in main.ts and reuse it. `accountsService.listAccounts()` returns rows with `name` and `config_dir` per usage.ts.)

Add to the services object passed to `registerIpcHandlers(...)`:

```ts
    cost: {
      get: (a: { configDir: string; projectPath: string; sessionId: string; accountName: string }) => sessionCostService.get(a),
      watch: (a: { configDir: string; projectPath: string; sessionId: string; accountName: string }) => sessionCostService.watch(a),
      unwatch: (sessionId: string) => sessionCostService.unwatch(sessionId),
      history: (f: Record<string, unknown>) =>
        costHistoryService.aggregate(f as never, ((f.groupBy as string) ?? 'day') as 'day' | 'week' | 'month'),
      sessions: (f: Record<string, unknown>) => costHistoryService.sessions(f as never),
      rescan: () => costHistoryService.backfill(accountsService.listAccounts()),
    },
```

- [ ] **Step 4: Add api.ts types + wrappers**

In `src/lib/api.ts` — types near the other usage types, methods near `getSubagentMeta`:

```ts
export interface SessionCostSnapshot {
  totalUsd: number;
  estimated: boolean;
  breakdown: { inputUsd: number; outputUsd: number; cacheReadUsd: number; cacheWriteUsd: number };
  subagentUsd: number;
  byModel: Array<{ model: string; usd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface CostHistoryPeriod {
  period: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  is_estimated: number;
}

export interface CostSessionRow {
  session_id: string;
  account_name: string;
  project_path: string | null;
  first_date: string;
  last_date: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface CostHistoryFilterParams {
  startDate?: string;
  endDate?: string;
  accountName?: string;
  projectPath?: string;
  model?: string;
}
```

```ts
  async sessionCostWatch(
    configDir: string,
    projectPath: string,
    sessionId: string,
    accountName: string,
  ): Promise<SessionCostSnapshot | null> {
    return apiCall("session_cost_watch", { configDir, projectPath, sessionId, accountName });
  },

  async sessionCostUnwatch(sessionId: string): Promise<null> {
    return apiCall("session_cost_unwatch", { sessionId });
  },

  async sessionCostHistory(
    filters: CostHistoryFilterParams & { groupBy: 'day' | 'week' | 'month' },
  ): Promise<CostHistoryPeriod[]> {
    return apiCall("session_cost_history", stripUndefined(filters));
  },

  async sessionCostSessions(filters: CostHistoryFilterParams): Promise<CostSessionRow[]> {
    return apiCall("session_cost_sessions", stripUndefined(filters));
  },

  async sessionCostRescan(): Promise<{ sessionsScanned: number } | null> {
    return apiCall("session_cost_rescan", {});
  },
```

If api.ts has no `stripUndefined` helper, add one near the top (repo rule: strip `undefined` optional params before IPC):

```ts
function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
```

(If an equivalent helper already exists in api.ts/apiAdapter.ts, use it instead.)

- [ ] **Step 5: Verify**

Run: `npm run check`
Expected: clean. (This validates the electron→src pricing import under both tsconfigs.)

Run: `npx vitest run electron/__tests__/ipc-handlers.test.ts electron/__tests__/ipc-channel-contract.test.ts`
Expected: PASS. If `ipc-channel-contract.test.ts` asserts an explicit channel list, add the six new channels to its expectation.

- [ ] **Step 6: Commit**

```bash
git add electron/ipc/channels.ts electron/ipc/handlers.ts electron/main.ts src/lib/api.ts electron/__tests__/ipc-channel-contract.test.ts
git commit -m "feat(cost): IPC surface for session cost + history, startup backfill and hourly sweep

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Fix usage.ts (correct rates, cache pricing, dedup)

**Files:**
- Modify: `electron/services/usage.ts` — replace `getCostPerToken` (lines ~162-171) and rework `extractUsageRows` (lines ~254-293)
- Test: `electron/__tests__/usage.test.ts` (update expectations + add dedup/cache cases)

**Interfaces:**
- Consumes: `computeMessageCost` from `../../src/lib/pricing` (usage.ts is at `electron/services/`, so two levels up).
- Produces: unchanged `ParsedUsage` shape — `cost` now includes cache costs and rows are deduped. No dashboard API change.

- [ ] **Step 1: Write the failing tests**

In `electron/__tests__/usage.test.ts`, add (adapting to the file's existing fixture helpers — read them first):

```ts
  it('prices opus 4.8 at current rates including cache tokens', () => {
    // fixture: one assistant message, model claude-opus-4-8, usage:
    // { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 }
    // expected cost:
    const M = 1_000_000;
    const expected =
      100 * (5 / M) + 200 * (25 / M) + 1000 * (5 / M) * 0.1 + 500 * (5 / M) * 1.25;
    // ...build the fixture the way this file's other tests do, run the scan, then:
    // expect(stats.total_cost).toBeCloseTo(expected, 10);
  });

  it('counts a multi-line message (same requestId) exactly once', () => {
    // fixture: two assistant lines sharing requestId 'req_1' and identical usage
    // expected: total_tokens counts the usage once, not twice
  });
```

Write these as real tests against the file's existing helpers (it already builds JSONL fixtures — mirror its style exactly). The comments above define the required assertions.

- [ ] **Step 2: Run to verify new tests fail**

Run: `npx vitest run electron/__tests__/usage.test.ts`
Expected: new tests FAIL (old rates / double counting); some existing cost-value expectations may now be wrong too — leave them for Step 4.

- [ ] **Step 3: Implement**

In `electron/services/usage.ts`:

1. Add import: `import { computeMessageCost } from '../../src/lib/pricing';`
2. Delete `getCostPerToken` entirely (lines ~162-171 incl. the "Cost model" comment block).
3. Extend `RawMessage`:

```ts
interface RawMessage {
  type: string;
  requestId?: string;
  message?: {
    id?: string;
    role?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
    model?: string;
  };
  timestamp?: string;
  cwd?: string;
}
```

4. Rework `extractUsageRows` to dedup and price via the shared module:

```ts
function extractUsageRows(
  messages: RawMessage[],
  sessionId: string,
  accountName: string,
  accountType: string,
): UsageRow[] {
  // One row per billed API request: the CLI writes one line per content
  // block, sharing requestId/message.id with identical usage — summing raw
  // lines double-counts. Last occurrence wins.
  const byKey = new Map<string, UsageRow>();
  let idx = 0;
  for (const msg of messages) {
    idx += 1;
    if (msg.type !== 'assistant') continue;
    if (!msg.message?.usage) continue;

    const usage = msg.message.usage;
    const model = msg.message.model ?? 'unknown';
    const key = msg.requestId ?? msg.message.id ?? `line:${idx}`;
    const { usd } = computeMessageCost(model, usage);

    const timestamp = msg.timestamp ?? '';
    const date = timestamp ? timestamp.substring(0, 10) : '';

    if (byKey.has(key)) byKey.delete(key);
    byKey.set(key, {
      session_id: sessionId,
      model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cost: usd,
      timestamp,
      date,
      account_name: accountName,
      account_type: accountType,
    });
  }
  return [...byKey.values()];
}
```

- [ ] **Step 4: Fix stale expectations and verify all pass**

Run: `npx vitest run electron/__tests__/usage.test.ts`
Update any existing assertions that hardcoded the old rates using the Global Constraints rate table (e.g. opus fixtures move from 15/75 to 5/25 unless they use a legacy id like `claude-opus-4-1`; cache tokens now add cost).
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add electron/services/usage.ts electron/__tests__/usage.test.ts
git commit -m "fix(usage): current model rates, cache-token pricing, per-request dedup

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Fix per-message footer cost (sessionStreamReducer)

**Files:**
- Modify: `src/lib/sessionStreamReducer.ts` — `computeCost` (lines ~280-299) and the `StreamReducerContext` type
- Modify: `src/components/AgentSession.tsx` — provide `seenCostKeys` + overrides in the reducer ctx
- Test: `src/lib/__tests__/sessionStreamReducer.test.ts` (update/add)

**Interfaces:**
- Consumes: `computeMessageCost`, `PricingOverrides`, `UsageTokens` from `@/lib/pricing`.
- Produces: `StreamReducerContext` gains two optional fields: `pricingOverrides?: PricingOverrides` and `seenCostKeys?: Set<string>`. `costDelta` semantics: model-aware + cache-aware; `cli-stream-result` nodes contribute 0 (their usage is a rollup of assistant messages already counted — adding both double-counts); repeated assistant deliveries for the same `requestId`/`message.id` contribute 0 after the first.

- [ ] **Step 1: Write the failing tests**

In `src/lib/__tests__/sessionStreamReducer.test.ts`, locate how existing tests build assistant nodes and ctx (mirror that style), then add:

```ts
describe('costDelta pricing', () => {
  const M = 1_000_000;

  it('prices by model with cache tokens (opus 4.8)', () => {
    // assistant node: raw.message = { id: 'm1', model: 'claude-opus-4-8',
    //   usage: { input_tokens: 2, output_tokens: 5199, cache_read_input_tokens: 190350 } }
    // expected costDelta:
    const expected = 2 * (5 / M) + 5199 * (25 / M) + 190350 * (5 / M) * 0.1;
    // build node + ctx per this file's existing helpers, call reduceSessionStreamMessage,
    // expect(result.costDelta).toBeCloseTo(expected, 10);
  });

  it('cli-stream-result contributes zero (rollup of already-counted messages)', () => {
    // cli-stream-result node with raw.usage = { input_tokens: 100, output_tokens: 100 }
    // expect(result.costDelta).toBe(0);
  });

  it('same requestId delivered twice counts once when ctx.seenCostKeys is provided', () => {
    // ctx with seenCostKeys: new Set(); two assistant nodes with raw.requestId 'req_1'
    // first: costDelta > 0; second: costDelta === 0
  });
});
```

Write these as real tests using the file's existing node/ctx builders; the comments define the assertions.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/__tests__/sessionStreamReducer.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

In `src/lib/sessionStreamReducer.ts`:

1. Import: `import { computeMessageCost, type PricingOverrides, type UsageTokens } from '@/lib/pricing';`
2. Add to the `StreamReducerContext` interface (wherever it's declared in this file):

```ts
  /** Optional pricing overrides (per MTok), loaded once per session. */
  pricingOverrides?: PricingOverrides;
  /** Dedup set for cost accounting: requestId/message.id keys already priced.
   *  Live streams re-deliver assistant messages per content block; without
   *  this, session cost inflates. Owned by the caller, reset per session. */
  seenCostKeys?: Set<string>;
```

3. Replace `computeCost`:

```ts
function computeCost(node: JsonlNode, ctx: StreamReducerContext): number {
  // Only assistant nodes are priced. cli-stream-result usage is the CLI's
  // rollup of the same assistant messages — counting both double-counts.
  if (node.kind !== 'assistant') return 0;
  const raw = node.raw as {
    requestId?: string;
    message?: { id?: string; model?: string; usage?: UsageTokens };
  };
  const usage = raw.message?.usage;
  if (!usage) return 0;
  const key = raw.requestId ?? raw.message?.id;
  if (key && ctx.seenCostKeys) {
    if (ctx.seenCostKeys.has(key)) return 0;
    ctx.seenCostKeys.add(key);
  }
  return computeMessageCost(raw.message?.model ?? '', usage, ctx.pricingOverrides).usd;
}
```

4. Update the call site (`costDelta: computeCost(node)` → `costDelta: computeCost(node, ctx)`).

- [ ] **Step 4: Wire ctx in AgentSession**

In `src/components/AgentSession.tsx`, where the reducer ctx object is built (`streamCtxRef` — the object carrying `setClaudeSessionId` etc.):
- Add `seenCostKeys: new Set<string>()` to the ctx object (created once with the ref, so it persists across messages; if the ctx is rebuilt per session/tab, that reset is exactly right).
- Load overrides once on mount and stash on the ctx:

```ts
  useEffect(() => {
    void apiCall('get_setting', { key: 'pricing_overrides' }).then((raw) => {
      streamCtxRef.current.pricingOverrides = parsePricingOverrides(raw as string | null);
    }).catch(() => {});
  }, []);
```

with imports `import { parsePricingOverrides } from '@/lib/pricing';` and `apiCall` from `@/lib/apiAdapter` (or add a `getSetting` wrapper to api.ts if one doesn't exist — check first and follow the existing pattern).

- [ ] **Step 5: Run all reducer tests + check**

Run: `npx vitest run src/lib/__tests__/ && npm run check`
Expected: PASS / clean. Update any existing reducer tests that asserted the old flat-rate costDelta values (recompute expected values with the rate table).

- [ ] **Step 6: Commit**

```bash
git add src/lib/sessionStreamReducer.ts src/lib/__tests__/sessionStreamReducer.test.ts src/components/AgentSession.tsx
git commit -m "fix(session): model- and cache-aware per-message cost with request dedup

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Header widget — live computed session cost

**Files:**
- Create: `src/hooks/useSessionCost.ts`
- Modify: `src/components/AccountCard.tsx`
- Modify: `src/components/claude-code-session/CostWidget.tsx`
- Modify: `src/components/claude-code-session/UsageDetailPopover.tsx`
- Modify: `src/components/AgentSession.tsx:1926-1937` (AccountCard mount)

**Interfaces:**
- Consumes: `api.sessionCostWatch/sessionCostUnwatch`, `SessionCostSnapshot` (Task 6); event `session-cost:<sessionId>`.
- Produces:
  - `useSessionCost(args: { enabled: boolean; configDir?: string; projectPath?: string; sessionId?: string | null; accountName?: string }): SessionCostSnapshot | null`
  - `AccountCard` new optional props: `sessionId?: string | null; projectPath?: string`
  - `CostWidget` new optional props: `estimated?: boolean; breakdown?: SessionCostSnapshot | null`
  - `UsageDetailPopover` new optional prop: `sessionCost?: SessionCostSnapshot | null`

- [ ] **Step 1: Create the hook**

Create `src/hooks/useSessionCost.ts`:

```tsx
import { useEffect, useState } from 'react';
import { api, type SessionCostSnapshot } from '@/lib/api';

/**
 * Live computed session cost for cost-based accounts. Starts a main-process
 * watcher over the session's JSONL (+ subagents), seeds from the watch
 * response, then follows `session-cost:<sessionId>` push events. Cleans up
 * watcher + listener on unmount / arg change.
 */
export function useSessionCost(args: {
  enabled: boolean;
  configDir?: string;
  projectPath?: string;
  sessionId?: string | null;
  accountName?: string;
}): SessionCostSnapshot | null {
  const { enabled, configDir, projectPath, sessionId, accountName } = args;
  const [snapshot, setSnapshot] = useState<SessionCostSnapshot | null>(null);

  useEffect(() => {
    if (!enabled || !configDir || !projectPath || !sessionId || !accountName) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    api
      .sessionCostWatch(configDir, projectPath, sessionId, accountName)
      .then((snap) => {
        if (!cancelled && snap) setSnapshot(snap);
      })
      .catch(() => {});
    const unlisten = window.electronAPI.onEvent(
      `session-cost:${sessionId}`,
      (...eventArgs: unknown[]) => {
        const payload = eventArgs[0] as SessionCostSnapshot | undefined;
        if (payload && typeof payload.totalUsd === 'number') setSnapshot(payload);
      },
    );
    return () => {
      cancelled = true;
      unlisten();
      void api.sessionCostUnwatch(sessionId).catch(() => {});
    };
  }, [enabled, configDir, projectPath, sessionId, accountName]);

  return snapshot;
}
```

- [ ] **Step 2: Extend CostWidget**

In `src/components/claude-code-session/CostWidget.tsx`:
- Add props:

```ts
  /** True when any priced message used an unknown-model estimate. */
  estimated?: boolean;
  /** Computed snapshot for the tooltip breakdown (null = scraped fallback). */
  breakdown?: import('@/lib/api').SessionCostSnapshot | null;
```

- In the rendered value, prefix `~` when `estimated`:

```tsx
        <span className="font-mono text-right tabular-nums min-w-[5ch]">
          {estimated ? '~' : ''}{formatCost(costUsd)}
        </span>
```

- Replace the `tooltip` construction:

```ts
  const tooltip = [
    accountName ? `${accountName} · ${label}` : label,
    `${estimated ? '~' : ''}${formatCost(costUsd)}`,
    ...(breakdown
      ? [
          `input ${formatCost(breakdown.breakdown.inputUsd)} · output ${formatCost(breakdown.breakdown.outputUsd)}`,
          `cache read ${formatCost(breakdown.breakdown.cacheReadUsd)} · cache write ${formatCost(breakdown.breakdown.cacheWriteUsd)}`,
          breakdown.subagentUsd > 0 ? `subagents ${formatCost(breakdown.subagentUsd)}` : '',
          'computed from session transcript tokens',
        ]
      : ['billed per token — no rate-limit windows on this account']),
  ]
    .filter(Boolean)
    .join('\n');
```

- [ ] **Step 3: Extend UsageDetailPopover**

In `src/components/claude-code-session/UsageDetailPopover.tsx`:
- Add to `Props`: `sessionCost?: import('@/lib/api').SessionCostSnapshot | null;`
- At the top of the popover body (before the `data && data.ok` block), render when present:

```tsx
      {sessionCost && (
        <Section title="This session (computed)">
          <KV k="Total" v={`${sessionCost.estimated ? '~' : ''}$${sessionCost.totalUsd.toFixed(4)}`} />
          <KV k="Input" v={`$${sessionCost.breakdown.inputUsd.toFixed(4)}`} />
          <KV k="Output" v={`$${sessionCost.breakdown.outputUsd.toFixed(4)}`} />
          <KV k="Cache read" v={`$${sessionCost.breakdown.cacheReadUsd.toFixed(4)}`} />
          <KV k="Cache write" v={`$${sessionCost.breakdown.cacheWriteUsd.toFixed(4)}`} />
          {sessionCost.subagentUsd > 0 && (
            <KV k="Subagents" v={`$${sessionCost.subagentUsd.toFixed(4)}`} />
          )}
          <KV
            k="Tokens"
            v={`${sessionCost.tokens.input} in / ${sessionCost.tokens.output} out / ${sessionCost.tokens.cacheRead} cr / ${sessionCost.tokens.cacheWrite} cw`}
          />
        </Section>
      )}
```

- [ ] **Step 4: Wire AccountCard**

In `src/components/AccountCard.tsx`:
- Props: add `sessionId?: string | null;` and `projectPath?: string;`
- After the `costBased` const:

```ts
  const computedCost = useSessionCost({
    enabled: costBased,
    configDir,
    projectPath,
    sessionId,
    accountName,
  });
  const sessionCostUsd = computedCost
    ? computedCost.totalUsd
    : usageData?.ok ? usageData.parsed.session.cost_usd : null;
```

(import `useSessionCost` from `@/hooks/useSessionCost`; this replaces the existing `sessionCostUsd` assignment at lines 71-72 — computed wins, scraped is the fallback until the first snapshot arrives.)
- Pass through to the widget and popover:

```tsx
              <CostWidget
                costUsd={sessionCostUsd}
                estimated={computedCost?.estimated ?? false}
                breakdown={computedCost}
                loading={usageLoading}
                accountName={accountName}
                onClick={() => { setUsagePopoverOpen((v) => !v); }}
                hideLabel
              />
```

and on `UsageDetailPopover`: `sessionCost={costBased ? computedCost : null}`.

- [ ] **Step 5: Pass session identity from AgentSession**

In `src/components/AgentSession.tsx` at the AccountCard mount (~line 1926), add:

```tsx
              sessionId={claudeSessionId}
              projectPath={projectPath}
```

- [ ] **Step 6: Verify**

Run: `npm run check && npm run build`
Expected: clean.
Then launch (`npm start`), open a session on the work account, and confirm the header pill shows a nonzero, ticking dollar figure and the popover shows the "This session (computed)" section. Report what you observed.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useSessionCost.ts src/components/AccountCard.tsx src/components/claude-code-session/CostWidget.tsx src/components/claude-code-session/UsageDetailPopover.tsx src/components/AgentSession.tsx
git commit -m "feat(ui): live computed session cost in account header widget

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Costs view (history page)

**Files:**
- Create: `src/components/CostsView.tsx`
- Modify: `src/components/UsageDashboard.tsx` — add a Usage/Costs view toggle

**Interfaces:**
- Consumes: `api.sessionCostHistory`, `api.sessionCostSessions`, `api.sessionCostRescan`, `CostHistoryPeriod`, `CostSessionRow` (Task 6); `useAccounts` from `@/contexts/AccountsContext`.
- Produces: `<CostsView />` (no props).

- [ ] **Step 1: Create CostsView**

Create `src/components/CostsView.tsx`. Reuse the dashboard's existing visual language (tables + inline percent bars — no new chart dependency):

```tsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, type CostHistoryPeriod, type CostSessionRow } from '@/lib/api';
import { useAccounts } from '@/contexts/AccountsContext';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type GroupBy = 'day' | 'week' | 'month';

function utcMonthStart(): string {
  return new Date().toISOString().slice(0, 8) + '01';
}

function fmtUsd(v: number): string {
  return v >= 0.01 || v === 0 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

const RANGE_PRESETS = [
  { key: 'month', label: 'This month (UTC)' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'all', label: 'All time' },
] as const;

function rangeFor(key: (typeof RANGE_PRESETS)[number]['key']): { startDate?: string } {
  if (key === 'month') return { startDate: utcMonthStart() };
  if (key === 'all') return {};
  const days = key === '30d' ? 30 : 90;
  const d = new Date(Date.now() - days * 86_400_000);
  return { startDate: d.toISOString().slice(0, 10) };
}

export function CostsView() {
  const { accounts } = useAccounts();
  const [rangeKey, setRangeKey] = useState<(typeof RANGE_PRESETS)[number]['key']>('month');
  const [groupBy, setGroupBy] = useState<GroupBy>('day');
  const [accountName, setAccountName] = useState<string>('all');
  const [periods, setPeriods] = useState<CostHistoryPeriod[]>([]);
  const [sessions, setSessions] = useState<CostSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const filters = {
        ...rangeFor(rangeKey),
        ...(accountName !== 'all' ? { accountName } : {}),
      };
      const [p, s] = await Promise.all([
        api.sessionCostHistory({ ...filters, groupBy }),
        api.sessionCostSessions(filters),
      ]);
      setPeriods(p);
      setSessions(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [rangeKey, groupBy, accountName]);

  useEffect(() => { void load(); }, [load]);

  const total = useMemo(() => periods.reduce((acc, p) => acc + p.cost_usd, 0), [periods]);
  const maxPeriod = useMemo(() => Math.max(1e-9, ...periods.map((p) => p.cost_usd)), [periods]);
  const anyEstimated = periods.some((p) => p.is_estimated === 1);

  const rescan = useCallback(async () => {
    setRescanning(true);
    try {
      await api.sessionCostRescan();
      await load();
    } finally {
      setRescanning(false);
    }
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {RANGE_PRESETS.map((r) => (
          <Button key={r.key} size="sm" variant={rangeKey === r.key ? 'default' : 'outline'}
            onClick={() => setRangeKey(r.key)}>{r.label}</Button>
        ))}
        <div className="mx-2 h-5 w-px bg-border" />
        {(['day', 'week', 'month'] as const).map((g) => (
          <Button key={g} size="sm" variant={groupBy === g ? 'default' : 'outline'}
            onClick={() => setGroupBy(g)}>{g}</Button>
        ))}
        <div className="mx-2 h-5 w-px bg-border" />
        <select
          className="h-8 rounded border bg-background px-2 text-xs"
          value={accountName}
          onChange={(e) => setAccountName(e.target.value)}
        >
          <option value="all">All accounts</option>
          {accounts.map((a) => (
            <option key={a.name} value={a.name}>{a.name}</option>
          ))}
        </select>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => void rescan()} disabled={rescanning}
          title="Re-scan all surviving transcripts and rebuild history rows">
          <RefreshCw className={cn('mr-1 h-3.5 w-3.5', rescanning && 'animate-spin')} />
          Rescan
        </Button>
      </div>

      <div className="text-sm text-muted-foreground">
        Total for range: <span className="font-mono text-foreground">{anyEstimated ? '~' : ''}{fmtUsd(total)}</span>
        <span className="ml-3 text-xs">
          ⓘ Anthropic's console bills the org in UTC months and includes usage OmniFex can't see
          (other machines, teammates, pre-tracking sessions) — expect OmniFex ≤ console.
        </span>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Period</th>
                <th className="py-1 pr-2 font-medium">Cost</th>
                <th className="py-1 pr-2 font-medium w-1/2"></th>
                <th className="py-1 pr-2 font-medium text-right">Tokens (in/out)</th>
                <th className="py-1 font-medium text-right">Cache (r/w)</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.period} className="border-t border-border/50">
                  <td className="py-1 pr-2 font-mono">{p.period}</td>
                  <td className="py-1 pr-2 font-mono">{p.is_estimated ? '~' : ''}{fmtUsd(p.cost_usd)}</td>
                  <td className="py-1 pr-2">
                    <div className="h-2 rounded bg-primary/70" style={{ width: `${(p.cost_usd / maxPeriod) * 100}%` }} />
                  </td>
                  <td className="py-1 pr-2 text-right font-mono text-muted-foreground">
                    {p.input_tokens.toLocaleString()} / {p.output_tokens.toLocaleString()}
                  </td>
                  <td className="py-1 text-right font-mono text-muted-foreground">
                    {p.cache_read_tokens.toLocaleString()} / {p.cache_write_tokens.toLocaleString()}
                  </td>
                </tr>
              ))}
              {periods.length === 0 && (
                <tr><td colSpan={5} className="py-3 text-muted-foreground">No cost history in this range. Try Rescan.</td></tr>
              )}
            </tbody>
          </table>

          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Sessions in range (by cost)
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">Session</th>
                  <th className="py-1 pr-2 font-medium">Account</th>
                  <th className="py-1 pr-2 font-medium">Project</th>
                  <th className="py-1 pr-2 font-medium">Dates</th>
                  <th className="py-1 font-medium text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {sessions.slice(0, 50).map((s) => (
                  <tr key={s.session_id} className="border-t border-border/50">
                    <td className="py-1 pr-2 font-mono truncate max-w-[16ch]" title={s.session_id}>{s.session_id.slice(0, 12)}…</td>
                    <td className="py-1 pr-2">{s.account_name}</td>
                    <td className="py-1 pr-2 truncate max-w-[32ch]" title={s.project_path ?? ''}>{s.project_path}</td>
                    <td className="py-1 pr-2 font-mono">{s.first_date === s.last_date ? s.first_date : `${s.first_date} → ${s.last_date}`}</td>
                    <td className="py-1 text-right font-mono">{fmtUsd(s.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
```

(Adjust `useAccounts()` destructuring to that context's actual return shape — read `src/contexts/AccountsContext.tsx` first.)

- [ ] **Step 2: Add the toggle in UsageDashboard**

In `src/components/UsageDashboard.tsx`:
- `import { CostsView } from '@/components/CostsView';`
- Add state near the other useStates: `const [view, setView] = useState<'usage' | 'costs'>('usage');`
- At the top of the rendered content (above the existing filters), add a segmented toggle following the component's existing button styling:

```tsx
      <div className="mb-4 flex gap-2">
        <Button size="sm" variant={view === 'usage' ? 'default' : 'outline'} onClick={() => setView('usage')}>Usage</Button>
        <Button size="sm" variant={view === 'costs' ? 'default' : 'outline'} onClick={() => setView('costs')}>Costs</Button>
      </div>
      {view === 'costs' ? (
        <CostsView />
      ) : (
        <>{/* existing dashboard content, unchanged, wrapped */}</>
      )}
```

(If the file doesn't already import `Button`, follow whatever button element it currently uses for the date-range filter and match that instead.)

- [ ] **Step 3: Verify**

Run: `npm run check && npm run build`
Expected: clean.
Launch the app, open the Usage tab → Costs, hit Rescan, confirm periods + sessions populate for the work account and the "This month (UTC)" total looks plausible against the Anthropic console. Report observations.

- [ ] **Step 4: Commit**

```bash
git add src/components/CostsView.tsx src/components/UsageDashboard.tsx
git commit -m "feat(ui): Costs view with UTC-month reconciliation filters and rescan

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Pricing overrides editor in Settings

**Files:**
- Create: `src/components/PricingOverridesEditor.tsx`
- Modify: `src/components/Settings.tsx` — mount the editor as a section

**Interfaces:**
- Consumes: `get_setting`/`save_setting` invoke channels (existing), `parsePricingOverrides` from `@/lib/pricing`.
- Produces: `<PricingOverridesEditor />` (no props). Stores JSON in app setting key `pricing_overrides`.

- [ ] **Step 1: Create the editor**

Create `src/components/PricingOverridesEditor.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { apiCall } from '@/lib/apiAdapter';
import { parsePricingOverrides } from '@/lib/pricing';
import { Button } from '@/components/ui/button';

const PLACEHOLDER = `{
  "sonnet-5": { "input": 2, "output": 10 },
  "opus-4-8": { "input": 5, "output": 25, "cacheRead": 0.5 }
}`;

/**
 * Raw-JSON editor for per-model pricing overrides (USD per MTok). Keys are
 * model-id substring patterns; omitted fields derive from the standard
 * formula (cache read 0.1x input, write 1.25x/2x). Used for price drift,
 * intro pricing, or negotiated enterprise rates.
 */
export function PricingOverridesEditor() {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'saved' | 'invalid'>('idle');

  useEffect(() => {
    void apiCall('get_setting', { key: 'pricing_overrides' }).then((v) => {
      if (typeof v === 'string') setText(v);
    }).catch(() => {});
  }, []);

  const save = async () => {
    const trimmed = text.trim();
    if (trimmed && !parsePricingOverrides(trimmed)) {
      setStatus('invalid');
      return;
    }
    await apiCall('save_setting', { key: 'pricing_overrides', value: trimmed });
    setStatus('saved');
    setTimeout(() => setStatus('idle'), 2000);
  };

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Pricing overrides</div>
      <p className="text-xs text-muted-foreground">
        Optional per-model rate overrides in USD per million tokens. Keys are model-id
        substrings (longest match wins). Leave empty to use built-in Anthropic rates.
        Applies to the session cost widget, cost history, and per-message costs on next
        session start / rescan.
      </p>
      <textarea
        className="h-36 w-full rounded border bg-background p-2 font-mono text-xs"
        placeholder={PLACEHOLDER}
        value={text}
        onChange={(e) => { setText(e.target.value); setStatus('idle'); }}
        spellCheck={false}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void save()}>Save</Button>
        {status === 'saved' && <span className="text-xs text-green-400">Saved</span>}
        {status === 'invalid' && <span className="text-xs text-red-400">Not a valid overrides JSON object</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount in Settings**

Read `src/components/Settings.tsx`, find where general/app-level sections render, and add a section following the file's existing section markup conventions:

```tsx
<PricingOverridesEditor />
```

with the matching import. Match surrounding heading/card structure exactly.

- [ ] **Step 3: Verify**

Run: `npm run check && npm run build`
Expected: clean. In the app: save `{"opus-4-8":{"input":1,"output":1}}`, start a new work-account session, confirm the widget cost drops accordingly; then clear the override.

- [ ] **Step 4: Commit**

```bash
git add src/components/PricingOverridesEditor.tsx src/components/Settings.tsx
git commit -m "feat(settings): pricing overrides editor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Full verification gate

- [ ] **Step 1: Full gate**

Run, in order:

```bash
npm run check
npm run build
npm run test:coverage
npm run rebuild:electron
```

Expected: check clean, build clean, all tests pass, coverage on new `electron/services/cost/**` files ≥ 80% lines (vitest coverage text output), Electron ABI rebuilt.

- [ ] **Step 2: Manual smoke (report results, don't skip)**

1. `npm start`, open a project bound to the work account.
2. Header pill: nonzero `$` that increases after a turn completes (within ~1s of the CLI writing the transcript).
3. Tooltip shows the in/out/cache breakdown; popover shows "This session (computed)".
4. Per-message footer: cost consistent with model + cache math (spot-check one message: tokens × rates).
5. Usage tab → Costs: Rescan, then verify this month's total for the work account against the Anthropic console figure; expect OmniFex ≤ console.
6. Restart the app: history persists (rows came from DB, not rescans).

- [ ] **Step 3: Final commit if any fixups**

```bash
git add -A && git commit -m "chore(cost): verification fixups

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Then report: branch name, commands run and their results, and any deviations from the spec.
