import type { ResolveSlot } from '@/lib/api';
import type { Tab } from '@/contexts/TabContext';

/** Single-engine resolution shape baked into a started session's
 *  initialSessionConfig (mirrors AgentSession's accountResolution). */
export type FormAccountResolution = NonNullable<
  NonNullable<Tab['initialSessionConfig']>['accountResolution']
>;

/** Map one engine's resolved routing slot to the resolution shape the session
 *  header consumes. Returns null when that engine has no matching rule —
 *  callers must NOT fall back to the other engine's slot, or a Claude session
 *  ends up showing a Codex account (and vice versa). */
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
