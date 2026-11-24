import { hasOneMillionSuffix, resolveContextWindow, type ModelPricingInput } from './pricing';

/**
 * A live `contextUsage.maxTokens` is authoritative: the "[1m]" suffix does not survive a resume.
 * Fallback order: an explicit "[1m]", the running/resolved model's window from pricing.ts, the
 * account's settings.json pin (the only place the opt-in survives a resume), then 200k.
 */
export interface ContextCatalogEntry {
  value: string;
  resolvedModel?: string;
}

const ONE_MILLION = 1_000_000;
const SMALLEST_WINDOW = 200_000;

export function resolveContextLimit(opts: {
  sdkMaxTokens: number | null;
  model: string | undefined;
  defaultModel?: string | null;
  runningModel?: string | null;
  catalog?: readonly ContextCatalogEntry[] | null;
  pricingOverrides?: readonly ModelPricingInput[] | null;
}): number {
  const { sdkMaxTokens, model, defaultModel, runningModel, catalog, pricingOverrides } = opts;

  if (sdkMaxTokens != null && sdkMaxTokens > 0) {
    return sdkMaxTokens;
  }

  const usingDefault = !model || model === 'default';
  const resolveAlias = (value: string | undefined): string | undefined =>
    catalog?.find((e) => e.value === (value || 'default'))?.resolvedModel;
  const selectedResolved = resolveAlias(model);

  if (hasOneMillionSuffix(model) || hasOneMillionSuffix(selectedResolved)) return ONE_MILLION;

  // The account pin only speaks for a session running that default; an explicit cross-family pick must not inherit.
  if (hasOneMillionSuffix(defaultModel)) {
    if (usingDefault || familyOf(model) === familyOf(defaultModel)) return ONE_MILLION;
  }

  for (const candidate of [runningModel, selectedResolved, model]) {
    const window = resolveContextWindow(candidate, pricingOverrides);
    if (window != null && window > 0) return window;
  }
  return SMALLEST_WINDOW;
}

function familyOf(s: string | null | undefined): string | null {
  const m = s?.match(/opus|sonnet|haiku|fable/i);
  return m ? m[0].toLowerCase() : null;
}
