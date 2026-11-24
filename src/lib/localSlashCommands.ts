import type { SlashCommand } from '@/lib/api';

/** Never written into `<configDir>/commands/`: the Brain leaves no residue in the user's Claude config. */
export const RECALL_COMMAND_ID = 'omnifex:brain:recall';
export const STATUS_COMMAND_ID = 'omnifex:status';

export const LOCAL_SCOPE = 'omnifex';

function localCommand(
  fields: Pick<SlashCommand, 'id' | 'name' | 'full_command' | 'description'> & { namespace?: string },
): SlashCommand {
  return {
    ...fields,
    scope: LOCAL_SCOPE,
    file_path: '',
    content: '',
    allowed_tools: [],
    has_bash_commands: false,
    has_file_references: false,
    accepts_arguments: false,
  };
}

export function localSlashCommands(opts: { hasVault: boolean; hasSession?: boolean }): SlashCommand[] {
  const out: SlashCommand[] = [];
  if (opts.hasVault) {
    out.push(localCommand({
      id: RECALL_COMMAND_ID,
      name: 'recall',
      full_command: '/recall',
      namespace: 'brain',
      description: "Search this account's Brain and insert notes into the prompt",
    }));
  }
  // The CLI's /status is TUI-only and not advertised in stream-json; OmniFex draws `get_status` instead.
  if (opts.hasSession) {
    out.push(localCommand({
      id: STATUS_COMMAND_ID,
      name: 'status',
      full_command: '/status',
      description: 'Show the CLI status: version, account, model, MCP servers, settings',
    }));
  }
  return out;
}

export function isLocalSlashCommand(id: string): boolean {
  return id === RECALL_COMMAND_ID || id === STATUS_COMMAND_ID;
}

/** Full bodies, not paths: /recall is the fallback for when the model skipped the MCP tool. */
export function formatRecalledNotes(notes: { path: string; body: string }[]): string {
  if (notes.length === 0) return '';
  const blocks = notes.map((n) => `### ${n.path}\n\n${n.body.trimEnd()}\n`).join('\n');
  return `<recalled-notes>\n${blocks}</recalled-notes>\n\n`;
}
