/**
 * What to tell the user before reloading the renderer.
 *
 * Reload and Force Reload were stripped from the View menu because an
 * accidental Cmd+R lost real work: tab persistence dropped every tab whose
 * status was `running`, so a reload silently closed whatever was mid-turn.
 * That filter is gone (see `src/services/tabPersistence.ts`), which makes a
 * deliberate reload a reasonable recovery action again — it is the only way
 * out of a wedged renderer, such as an `isLoading` that never cleared.
 *
 * The menu item comes back; the accelerator does not. A reload is now
 * something you choose, never something you fat-finger, and the dialog is
 * what enforces that.
 *
 * Pure so the wording is testable without an Electron app instance; main.ts
 * owns the dialog and the `webContents.reload()` call.
 */

export interface ReloadPrompt {
  message: string;
  detail: string;
}

export type ReloadDecision = { action: 'confirm'; prompt: ReloadPrompt };

export interface ReloadPolicyInput {
  /** Sessions genuinely mid-turn — not ones paused on a permission prompt. */
  workingCount: number;
}

export function decideReload({ workingCount }: ReloadPolicyInput): ReloadDecision {
  // `>= 1` rather than `> 0` so NaN — which loses every comparison — reads as
  // "none working" instead of rendering `NaN sessions` at the user. The count
  // comes from a live aggregator that can report from a window being torn
  // down. Same guard as `decideQuit`, same reason.
  const working = workingCount >= 1 ? workingCount : 0;

  // Leading with what survives, because that is the non-obvious part: the
  // daemon owns every CLI process, so reloading this window does not touch
  // them. Quitting does — that is `decideQuit`'s job, and it says so.
  const survives =
    working === 0
      ? ''
      : working === 1
        ? '1 session keeps running in the background. '
        : `${working} sessions keep running in the background. `;

  return {
    action: 'confirm',
    prompt: {
      message: 'Reload the OmniFex window?',
      detail:
        `${survives}Open tabs are restored. Unsent composer drafts and ` +
        'queued prompts are lost.',
    },
  };
}
