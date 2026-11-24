/** `{ awake: false }` on lock and suspend, `{ awake: true }` on unlock and resume. */
export const POWER_STATE_CHANNEL = 'system-power-state';

export interface PowerState {
  awake: boolean;
}
