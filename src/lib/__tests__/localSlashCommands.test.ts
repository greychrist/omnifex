import { describe, it, expect } from 'vitest';
import {
  RECALL_COMMAND_ID,
  formatRecalledNotes,
  isLocalSlashCommand,
  localSlashCommands,
} from '@/lib/localSlashCommands';

describe('localSlashCommands', () => {
  it('offers /recall only when the account has a vault', () => {
    expect(localSlashCommands({ hasVault: true }).map((c) => c.id)).toEqual([RECALL_COMMAND_ID]);
    expect(localSlashCommands({ hasVault: false })).toEqual([]);
  });

  it('marks the command as OmniFex-local so the picker can badge it', () => {
    // It is deliberately NOT written into <configDir>/commands/ — the Brain
    // leaves no residue in the user's Claude config.
    const [recall] = localSlashCommands({ hasVault: true });
    expect(recall.scope).toBe('omnifex');
    expect(recall.full_command).toBe('/recall');
    expect(recall.file_path).toBe('');
  });

  it('identifies its own commands and nothing else', () => {
    expect(isLocalSlashCommand(RECALL_COMMAND_ID)).toBe(true);
    expect(isLocalSlashCommand('user:default:commit')).toBe(false);
    expect(isLocalSlashCommand('')).toBe(false);
  });
});

describe('formatRecalledNotes', () => {
  it('inserts each note whole, under its vault path', () => {
    // Full bodies, not pointers: /recall is the fallback for a session where
    // the model did not call the MCP tool, so a pointer would re-require the
    // very tool that was not used.
    expect(
      formatRecalledNotes([
        { path: 'Subsystems/Queue.md', body: 'the drain worker' },
        { path: 'Topics/Pty.md', body: 'node-pty leak' },
      ]),
    ).toBe(
      '<recalled-notes>\n' +
        '### Subsystems/Queue.md\n\nthe drain worker\n\n' +
        '### Topics/Pty.md\n\nnode-pty leak\n' +
        '</recalled-notes>\n\n',
    );
  });

  it('inserts nothing at all for an empty selection', () => {
    expect(formatRecalledNotes([])).toBe('');
  });

  it('trims trailing whitespace on a body so spacing stays even', () => {
    expect(formatRecalledNotes([{ path: 'A.md', body: 'text\n\n\n' }])).toBe(
      '<recalled-notes>\n### A.md\n\ntext\n</recalled-notes>\n\n',
    );
  });
});
