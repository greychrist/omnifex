/** Order is display order. */
export type ModCapability =
  | 'tool-calls'
  | 'prompts'
  | 'submits-prompts'
  | 'processes'
  | 'network'
  | 'models'
  | 'writes-files';

export interface ModInspection {
  hooks: string[];
  calls: string[];
  capabilities: ModCapability[];
}

/** `tool-calls` leads: a mod hooking `tool.call` can approve a call before OmniFex's permission prompt is asked. */
export const MOD_CAPABILITY_LABEL: Record<ModCapability, string> = {
  'tool-calls': 'Approves or blocks tool calls',
  prompts: 'Rewrites prompts',
  'submits-prompts': 'Sends prompts',
  processes: 'Runs processes',
  network: 'Network access',
  models: 'Calls models',
  'writes-files': 'Writes files',
};
