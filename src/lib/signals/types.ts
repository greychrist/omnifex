/**
 * Session signals — one typed model for everything a session needs to tell the
 * user, routed to the widget it concerns instead of stacked into banners.
 *
 * The app used to answer every "the user should know this" with another
 * horizontal bar above the transcript: context pressure, context jump, cache
 * TTL, skipped MCP servers, account mismatch, usage limit, thinking. Seven
 * notices in five components, all competing for the same strip of screen and
 * none of them attached to the thing they described.
 *
 * A signal names its `anchor` — the widget it is *about* — and its `kind`
 * decides what the UI does with it. Only `action` may ever take vertical
 * space, and only one at a time, in the `AttentionSlot`.
 *
 * See docs/superpowers/specs/2026-09-11-session-signals-design.md
 */

/**
 * What the UI does with the signal.
 *
 * - `state` — a current value. Updates its anchored widget in place; emitting
 *   the same `key` replaces the previous value. Never a bar, never a badge.
 * - `event` — something that happened. Appended to the anchor's event log and
 *   counted in its unread badge. Never a bar.
 * - `action` — something the user can do about it. Enters the attention queue
 *   and is mirrored into the anchor's popover.
 */
export type SignalKind = 'state' | 'event' | 'action';

/** The widget a signal is about. Each one owns a badge and a popover. */
export type SignalAnchor = 'session' | 'account' | 'branch' | 'agents' | 'mcp';

export type SignalPriority = 'low' | 'normal' | 'high';

export interface SignalAction {
  id: string;
  label: string;
  run: () => void | Promise<void>;
  primary?: boolean;
  /**
   * Rendered but inert. Needed because some actions are only *sometimes*
   * available — `/compact` cannot run mid-turn — and hiding the button instead
   * would make the slot's controls move under the cursor as a turn starts.
   */
  disabled?: boolean;
}

export interface SessionSignal {
  /**
   * Identity for de-dupe. Distinct from `key`: signals are *derived* from the
   * message stream on every render, so the same context jump is re-emitted
   * dozens of times and must land as one row. Anchor the id to what produced
   * it (a prompt uuid, a server name), not to the render.
   */
  id: string;
  tabId: string;
  kind: SignalKind;
  anchor: SignalAnchor;
  priority: SignalPriority;
  /**
   * Stable key for replace-in-place, e.g. `context.boundary`. `state` and
   * `action` signals with the same key supersede each other; events do not
   * (an event log with one row per key would be a state, not a log).
   */
  key: string;
  title: string;
  detail?: string;
  /** Epoch ms. */
  at: number;
  /** Events only. Cleared in bulk when the anchor's popover is opened. */
  read?: boolean;
  /** `action` kind only. */
  actions?: SignalAction[];
  meta?: Record<string, unknown>;
}

/** Highest first. The attention slot shows index 0. */
export const PRIORITY_RANK: Record<SignalPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

export const SIGNAL_ANCHORS: readonly SignalAnchor[] = [
  'session',
  'account',
  'branch',
  'agents',
  'mcp',
] as const;
