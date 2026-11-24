import type { ResolveSlot } from '@/lib/api';
import type { Tab } from '@/contexts/TabContext';

export type FormAccountResolution = NonNullable<
  NonNullable<Tab['initialSessionConfig']>['accountResolution']
>;

/** Null when this engine has no rule; never fall back to the other engine's slot. */
export function slotToResolution(
  slot: ResolveSlot | null | undefined,
): FormAccountResolution | null {
  if (!slot) return null;
  return {
    account: {
      name: slot.account.name,
      subscription_label: slot.account.subscription_label,
      has_cost: slot.account.has_cost,
      config_dir: slot.account.config_dir,
      session_defaults: slot.account.session_defaults,
    },
    match_type: slot.matchType,
    match_detail: slot.matchDetail,
  };
}
