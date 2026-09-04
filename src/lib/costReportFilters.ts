// Cost Report — filter state and formatting, kept pure and out of the view.
//
// The filter bar's state is the single source of truth for every panel on the
// page, so the state → query-params mapping is the one place a bug would show
// up as "two panels disagree about what they're showing". It lives here, with
// tests, rather than inline in the component.

import type { CostHistoryFilterParams } from '@/lib/api';
import {
  emptyFilterState,
  resolveRange,
  type CostFilterState,
  type CostScope,
} from '@/lib/costFilterState';

// The state shape and its defaults live in costFilterState.ts so the main
// process can import them without dragging the renderer API in. Re-exported
// here so every existing `from '@/lib/costReportFilters'` still resolves.
export {
  RANGE_PRESETS,
  emptyFilterState,
  resolveRange,
  utcToday,
  type CostFilterState,
  type CostScope,
  type RangeKey,
} from '@/lib/costFilterState';

/**
 * Filter state → the shape every cost query takes.
 *
 * Empty multi-selects are omitted rather than sent as `[]`. The service reads
 * an empty array as "no filter" too, but omitting keeps the IPC payload honest
 * about what the user actually chose.
 *
 * A custom date beats the preset. The alternative — preset wins — makes typing
 * a start date look like it did nothing.
 */
export function toFilterParams(state: CostFilterState, today: string): CostHistoryFilterParams {
  const preset = resolveRange(state.rangeKey, today);
  const params: CostHistoryFilterParams = {};

  const startDate = state.customStart || preset.startDate;
  const endDate = state.customEnd || preset.endDate;
  if (startDate) params.startDate = startDate;
  if (endDate) params.endDate = endDate;

  if (state.accounts.length) params.accountName = state.accounts;
  if (state.models.length) params.model = state.models;
  if (state.projects.length) params.projectPath = state.projects;

  if (state.scope !== 'all') params.isSubagent = state.scope === 'subagent';

  return params;
}

/** Sub-cent figures matter here — a $0.0031 per-request cost rounded to $0.00
 *  is the whole subagent-efficiency finding erased. */
export function fmtUsd(v: number): string {
  if (v !== 0 && Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function fmtPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Reads as a ratio because that is what it is; a bare `35.4` invites being
 *  mistaken for a dollar figure in a table full of them. */
export function fmtRatio(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '—';
  return ratio >= 10 ? `${Math.round(ratio)}:1` : `${ratio.toFixed(1)}:1`;
}

// ── Persistence ────────────────────────────────────────────────────────────
//
// localStorage rather than `app_settings`, matching how the rest of the
// renderer stores view state (LogTab column widths, SubagentBar collapse,
// AgentSession header height). It also reads synchronously, so the page opens
// already filtered instead of flashing the defaults while an async setting
// loads.

const STORAGE_KEY = 'omnifex.costReport.filters';

/** Fields that survive a relaunch. The date range deliberately does not: an
 *  absolute window saved in August is meaningless in October and would
 *  silently show an empty page. */
type PersistedFilters = Pick<
  CostFilterState,
  'accounts' | 'models' | 'projects' | 'scope' | 'groupBy'
>;

const SCOPES: CostScope[] = ['all', 'main', 'subagent'];
const GROUP_BYS: CostFilterState['groupBy'][] = ['day', 'week', 'month'];

/** Only strings survive — a stored array from an older build must not smuggle
 *  a non-string into an `IN (...)` clause. */
function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function saveFilterState(state: CostFilterState): void {
  const persisted: PersistedFilters = {
    accounts: state.accounts,
    models: state.models,
    projects: state.projects,
    scope: state.scope,
    groupBy: state.groupBy,
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // Quota or private mode — the filters just won't be remembered.
  }
}

/**
 * The remembered filters, merged over the defaults. Every field is validated
 * against the values this build actually accepts: a stale `scope` or `groupBy`
 * from an older build must fall back rather than reach a query.
 */
export function loadFilterState(): CostFilterState {
  const base = emptyFilterState();
  let raw: unknown;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return base;
    raw = JSON.parse(stored);
  } catch {
    return base;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const p = raw as Record<string, unknown>;

  return {
    ...base,
    accounts: stringArray(p.accounts),
    models: stringArray(p.models),
    projects: stringArray(p.projects),
    scope: SCOPES.includes(p.scope as CostScope) ? (p.scope as CostScope) : base.scope,
    groupBy: GROUP_BYS.includes(p.groupBy as CostFilterState['groupBy'])
      ? (p.groupBy as CostFilterState['groupBy'])
      : base.groupBy,
  };
}
