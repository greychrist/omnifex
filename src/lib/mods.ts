/**
 * Mods (Claude Code >= 2.1.287): plugins carrying TypeScript hooks the CLI
 * runs in its own process. Shared by main (electron/services/sessions/mods.ts
 * reads them) and the Session context panel (shows them), so the capability
 * set and its wording are defined once.
 */

/** What a mod can do, read from `claude plugin validate`. Order is display order. */
export type ModCapability =
  | 'tool-calls'
  | 'prompts'
  | 'submits-prompts'
  | 'processes'
  | 'network'
  | 'models'
  | 'writes-files';

export interface ModInspection {
  /** Events it hooks, matchers kept: `tool.call{tool=Bash}`. */
  hooks: string[];
  /** Mods API calls it makes, without the `$.`: `fs.write`. */
  calls: string[];
  capabilities: ModCapability[];
}

/**
 * Labels for the panel. `tool-calls` leads because it is the one that
 * reaches past OmniFex: a mod hooking `tool.call` / `tool.check` can approve
 * a call before OmniFex's permission prompt is ever asked.
 */
export const MOD_CAPABILITY_LABEL: Record<ModCapability, string> = {
  'tool-calls': 'Approves or blocks tool calls',
  prompts: 'Rewrites prompts',
  'submits-prompts': 'Sends prompts',
  processes: 'Runs processes',
  network: 'Network access',
  models: 'Calls models',
  'writes-files': 'Writes files',
};
