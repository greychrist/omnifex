/**
 * Main → renderer: whether the machine is in use. `{ awake: false }` on screen
 * lock and suspend, `{ awake: true }` on unlock and resume. Emitted by
 * electron/power-state.ts; read by useGitWatchVisibility to pause git polling
 * nobody can see.
 */
export const POWER_STATE_CHANNEL = 'system-power-state';

export interface PowerState {
  awake: boolean;
}
