export type ContextPressureMode = 'percent' | 'tokens';

export interface ContextPressureSetting {
  enabled: boolean;
  mode: ContextPressureMode;
  /** Percent of the window (1-100), or an absolute token count. */
  value: number;
}

export const CONTEXT_PRESSURE_ENABLED_SETTING_KEY = 'context_pressure_enabled';
export const CONTEXT_PRESSURE_MODE_SETTING_KEY = 'context_pressure_mode';
export const CONTEXT_PRESSURE_VALUE_SETTING_KEY = 'context_pressure_value';

export const DEFAULT_CONTEXT_PRESSURE_PERCENT = 80;
export const DEFAULT_CONTEXT_PRESSURE_TOKENS = 250_000;

export const DEFAULT_CONTEXT_PRESSURE: ContextPressureSetting = {
  enabled: true,
  mode: 'tokens',
  value: DEFAULT_CONTEXT_PRESSURE_TOKENS,
};

/** Clamps an absolute budget below the window: the CLI auto-compacts before 100%, so `critical` would be unreachable on 200k. */
export const ABSOLUTE_BUDGET_WINDOW_FRACTION = 0.95;

const WARN_FRACTION_OF_BUDGET = 0.8;

const MIN_ABSOLUTE_TOKENS = 1_000;

export type ContextPressureLevel = 'none' | 'warn' | 'critical';

export interface ContextPressure {
  level: ContextPressureLevel;
  budgetTokens: number;
  pct: number;
}

export function defaultValueForMode(mode: ContextPressureMode): number {
  return mode === 'percent'
    ? DEFAULT_CONTEXT_PRESSURE_PERCENT
    : DEFAULT_CONTEXT_PRESSURE_TOKENS;
}

export function clampContextPressureValue(
  value: number,
  mode: ContextPressureMode,
): number {
  const n = Math.floor(value);
  if (!Number.isFinite(n)) return defaultValueForMode(mode);
  if (mode === 'percent') return Math.min(100, Math.max(1, n));
  return Math.max(MIN_ABSOLUTE_TOKENS, n);
}

export function parseContextPressureMode(raw: string | null): ContextPressureMode {
  if (raw === 'percent' || raw === 'tokens') return raw;
  return DEFAULT_CONTEXT_PRESSURE.mode;
}

export function parseContextPressureValue(
  raw: string | null,
  mode: ContextPressureMode,
): number {
  if (raw === null) return defaultValueForMode(mode);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return defaultValueForMode(mode);
  return clampContextPressureValue(n, mode);
}

export function parseContextPressureEnabled(raw: string | null): boolean {
  if (raw === null) return DEFAULT_CONTEXT_PRESSURE.enabled;
  return raw === 'true';
}

export function resolveBudgetTokens(
  setting: ContextPressureSetting,
  limit: number,
): number {
  const value = clampContextPressureValue(setting.value, setting.mode);
  if (setting.mode === 'percent') {
    return Math.floor(limit * (value / 100));
  }
  return Math.floor(Math.min(value, limit * ABSOLUTE_BUDGET_WINDOW_FRACTION));
}

/** Shared by the banner and the context rail so "amber" means one thing; never copy the thresholds. */
export function contextPressureLevel(opts: {
  tokens: number;
  limit: number;
  setting: ContextPressureSetting;
}): ContextPressureLevel {
  const { tokens, limit, setting } = opts;
  if (tokens <= 0 || limit <= 0) return 'none';
  const budgetTokens = resolveBudgetTokens(setting, limit);
  if (budgetTokens <= 0) return 'none';
  if (tokens >= budgetTokens) return 'critical';
  return tokens >= budgetTokens * WARN_FRACTION_OF_BUDGET ? 'warn' : 'none';
}

export function evaluateContextPressure(opts: {
  tokens: number;
  limit: number;
  setting: ContextPressureSetting;
  /** sessionStatus === 'started': the banner's only action is /compact, which a starting session cannot run. */
  sessionLive?: boolean;
}): ContextPressure {
  const { tokens, limit, setting, sessionLive = true } = opts;
  const inert: ContextPressure = { level: 'none', budgetTokens: 0, pct: 0 };
  if (!sessionLive || !setting.enabled || tokens <= 0 || limit <= 0) return inert;

  const budgetTokens = resolveBudgetTokens(setting, limit);
  const pct = Math.min(100, (tokens / limit) * 100);
  if (budgetTokens <= 0) return inert;

  return { level: contextPressureLevel({ tokens, limit, setting }), budgetTokens, pct };
}

export function selectContextTokens(opts: {
  contextUsage: { totalTokens: number; maxTokens: number } | null | undefined;
  fallbackTokens: number;
}): { tokens: number; sdkMaxTokens: number | null } {
  const { contextUsage, fallbackTokens } = opts;
  if (contextUsage) {
    return { tokens: contextUsage.totalTokens, sdkMaxTokens: contextUsage.maxTokens };
  }
  return { tokens: fallbackTokens, sdkMaxTokens: null };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
