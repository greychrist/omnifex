/** `state` replaces in place by key; `event` is logged and badged; `action` enters the attention queue, the only kind that takes vertical space. */
export type SignalKind = 'state' | 'event' | 'action';

export type SignalAnchor = 'session' | 'account' | 'branch' | 'agents' | 'mcp';

export type SignalPriority = 'low' | 'normal' | 'high';

export interface SignalAction {
  id: string;
  label: string;
  run: () => void | Promise<void>;
  primary?: boolean;
  /** Inert, not hidden: hiding it would move the slot's controls under the cursor. */
  disabled?: boolean;
}

export interface SessionSignal {
  /** De-dupe identity: signals are re-derived every render, so anchor the id to its source (a prompt uuid), never the render. */
  id: string;
  tabId: string;
  kind: SignalKind;
  anchor: SignalAnchor;
  priority: SignalPriority;
  /** Replace-in-place key for `state`/`action`; events never supersede by key. */
  key: string;
  title: string;
  detail?: string;
  /** Epoch ms. */
  at: number;
  read?: boolean;
  actions?: SignalAction[];
  messageUuid?: string;
  meta?: Record<string, unknown>;
}

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
