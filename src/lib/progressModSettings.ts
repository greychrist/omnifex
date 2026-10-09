/**
 * Agent step progress — the bundled OmniFex mod that gives every session a
 * progress tool. Shared by the renderer's Settings panel and main's spawn path
 * (`electron/services/bundled-mod.ts`) so the key and default are stated once.
 */
export const PROGRESS_MOD_ENABLED_KEY = 'sessions.progressMod.enabled';

/** On unless explicitly switched off. */
export function progressModEnabled(stored: string | null): boolean {
  return stored !== 'false';
}
