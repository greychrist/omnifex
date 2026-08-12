import type { SlashCommand } from '@/lib/api';

/**
 * Slash commands OmniFex itself provides.
 *
 * Deliberately NOT written into `<configDir>/commands/`: the Brain leaves no
 * residue in the user's Claude config (spec §15). They are injected into the
 * picker's list and dispatched to a handler instead of being inserted as text.
 *
 * A lookup rather than a special case in the picker, so a second local command
 * is not bolted onto the first.
 */
export const RECALL_COMMAND_ID = 'omnifex:brain:recall';

/** Scope value that marks a command as OmniFex-local rather than CLI-sourced. */
export const LOCAL_SCOPE = 'omnifex';

export function localSlashCommands(opts: { hasVault: boolean }): SlashCommand[] {
  // An account with no vault gets no /recall: the dialog would open onto a
  // vault that does not exist and every search would come back empty.
  if (!opts.hasVault) return [];
  return [
    {
      id: RECALL_COMMAND_ID,
      name: 'recall',
      full_command: '/recall',
      scope: LOCAL_SCOPE,
      namespace: 'brain',
      // No file backs it — that is the point.
      file_path: '',
      content: '',
      description: "Search this account's Brain and insert notes into the prompt",
      allowed_tools: [],
      has_bash_commands: false,
      has_file_references: false,
      accepts_arguments: false,
    },
  ];
}

export function isLocalSlashCommand(id: string): boolean {
  return id === RECALL_COMMAND_ID;
}

/**
 * The text `/recall` inserts at the cursor.
 *
 * Full bodies rather than paths or summaries: `/recall` exists as the fallback
 * for a session where the model did not call the MCP tool, so a pointer would
 * re-require the very tool that was not used. The context cost is bounded by
 * what the user deliberately picked.
 */
export function formatRecalledNotes(notes: { path: string; body: string }[]): string {
  if (notes.length === 0) return '';
  const blocks = notes.map((n) => `### ${n.path}\n\n${n.body.trimEnd()}\n`).join('\n');
  return `<recalled-notes>\n${blocks}</recalled-notes>\n\n`;
}
