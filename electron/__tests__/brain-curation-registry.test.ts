import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createBrainService, type BrainService } from '../services/brain/registry';
import { CURATION_SOURCE_ID } from '../services/brain/queue';
import { MAX_NOTES_PER_RUN, MIN_TIMELINE_ENTRIES } from '../services/brain/curate';
import type { AccountsService } from '../services/accounts';
import type { ParsedNote } from '../services/brain/types';

/** Never spawns git: cleanup must not race an untracked child process. */
const stubExec = async () => '';

const accountsStub = {
  listAccounts: () => [{ id: 1, config_dir: '/cfg/personal' }],
} as unknown as AccountsService;

function noteWith(entries: number): ParsedNote {
  const lines = Array.from({ length: entries }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return `- **2026-01-${day}**: Entry ${String(i + 1)}.`;
  });
  return {
    frontmatter: {
      type: 'Subsystem',
      aliases: [],
      keywords: [],
      created: '2026-01-01',
      updated: '2026-02-01',
      sources: ['session:a'],
    },
    body: [
      '# Widget',
      '',
      '## Summary',
      'A widget.',
      '',
      '## Connected to',
      '',
      '## Timeline',
      ...lines,
      '',
      '## Decisions',
      '',
      '## Key facts',
      '',
      '## Open items',
      '- Ask Greg.',
      '',
      '## Assistant notes',
      '',
    ].join('\n'),
  };
}

describe('curation on the registry', () => {
  let db: Database;
  let dir: string;
  let brain: BrainService;
  let curator: ReturnType<typeof vi.fn>;
  const accountId = 1;

  beforeEach(() => {
    db = createDatabase(':memory:');
    // `brain_queue.account_id` is a real foreign key, so the account has to
    // exist before anything can be enqueued against it.
    db.raw
      .prepare(
        `INSERT INTO accounts (id, name, config_dir, engine, subscription_label, has_cost)
         VALUES (1, 'personal', '/cfg/personal', 'claude', 'Max', 0)`,
      )
      .run();
    dir = mkdtempSync(join(tmpdir(), 'brain-curation-'));
    curator = vi.fn().mockResolvedValue({ collapsed: 'Early work.', promotedFacts: ['A fact.'] });
    brain = createBrainService(db, {
      execGit: stubExec,
      curator: curator as never,
      accounts: accountsStub,
    });
    brain.setVaultPath(accountId, join(dir, 'vault'));
  });

  afterEach(() => {
    brain.closeAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('curates a qualifying note and commits as Curation', async () => {
    brain.writeNote(accountId, 'Subsystems/Widget.md', noteWith(12), 'seed');

    const result = await brain.curateNote(accountId, 'Subsystems/Widget.md');

    expect(result.skipped).toBe(false);
    expect(curator).toHaveBeenCalledTimes(1);
    const note = brain.open(accountId)?.vault.readNote('Subsystems/Widget.md');
    expect(note?.body).toContain('entries collapsed)_');
    expect(note?.body).toContain('- A fact.');
    expect(note?.frontmatter.curated_at).toBeDefined();
    // The human section survives a model-driven rewrite.
    expect(note?.body).toContain('- Ask Greg.');
  });

  it('is handed exactly the entries the fold will collapse', async () => {
    brain.writeNote(accountId, 'Subsystems/Widget.md', noteWith(12), 'seed');
    await brain.curateNote(accountId, 'Subsystems/Widget.md');

    const input = curator.mock.calls[0][0] as { entries: string[]; title: string };
    expect(input.title).toBe('Widget');
    expect(input.entries).toHaveLength(7);
    expect(input.entries[0]).toContain('Entry 1.');
    expect(input.entries[6]).toContain('Entry 7.');
  });

  it('runs under the owning account config dir', async () => {
    brain.writeNote(accountId, 'Subsystems/Widget.md', noteWith(12), 'seed');
    await brain.curateNote(accountId, 'Subsystems/Widget.md');
    expect(curator.mock.calls[0][1]).toBe('/cfg/personal');
  });

  it('spends nothing on a note that no longer qualifies', async () => {
    brain.writeNote(accountId, 'Subsystems/Short.md', noteWith(3), 'seed');

    const result = await brain.curateNote(accountId, 'Subsystems/Short.md');

    expect(result.skipped).toBe(true);
    expect(curator).not.toHaveBeenCalled();
  });

  it('spends nothing on a note that disappeared between enqueue and claim', async () => {
    const result = await brain.curateNote(accountId, 'Subsystems/Gone.md');
    expect(result.skipped).toBe(true);
    expect(curator).not.toHaveBeenCalled();
  });

  it('leaves the note untouched when the model reply is unusable', async () => {
    brain.writeNote(accountId, 'Subsystems/Widget.md', noteWith(12), 'seed');
    const before = brain.open(accountId)?.vault.readNote('Subsystems/Widget.md');
    curator.mockRejectedValue(new Error('curation failed validation'));

    await expect(brain.curateNote(accountId, 'Subsystems/Widget.md')).rejects.toThrow(
      'curation failed validation',
    );

    const after = brain.open(accountId)?.vault.readNote('Subsystems/Widget.md');
    expect(after?.body).toBe(before?.body);
    expect(after?.frontmatter.curated_at).toBeUndefined();
  });

  it('enqueues only qualifying notes, longest first', () => {
    brain.writeNote(accountId, 'Subsystems/Short.md', noteWith(3), 'seed');
    brain.writeNote(accountId, 'Subsystems/Long.md', noteWith(20), 'seed');
    brain.writeNote(accountId, 'Subsystems/Medium.md', noteWith(MIN_TIMELINE_ENTRIES), 'seed');

    const queued = brain.enqueueCuration(accountId);

    expect(queued).toBe(2);
    const rows = brain.queueList(accountId).filter((r) => r.sourceId === CURATION_SOURCE_ID);
    // queueList is newest-first; reversing gives enqueue order.
    expect(rows.map((r) => r.itemKey).reverse()).toEqual([
      'Subsystems/Long.md',
      'Subsystems/Medium.md',
    ]);
  });

  it('caps one run at MAX_NOTES_PER_RUN', () => {
    for (let i = 0; i < MAX_NOTES_PER_RUN + 3; i += 1) {
      brain.writeNote(accountId, `Subsystems/N${String(i)}.md`, noteWith(12), 'seed');
    }
    expect(brain.enqueueCuration(accountId)).toBe(MAX_NOTES_PER_RUN);
  });

  it('returns 0 when no vault is configured', () => {
    brain.clearVaultPath(accountId);
    expect(brain.enqueueCuration(accountId)).toBe(0);
  });

  it('commits the curated note under the message "Curation"', async () => {
    // The commit is fire-and-forget (`commitAndRecord`), so a live `git log`
    // read immediately after curateNote resolves races it. Asserting on the
    // captured argv is what makes the spec's audit-trail claim testable.
    const calls: string[][] = [];
    const svc = createBrainService(db, {
      // `commitAll` asks git what is staged and returns `nothing-to-commit`
      // when the answer is empty, so a stub that returns '' for everything
      // never reaches `git commit` at all.
      execGit: async (args: string[]) => {
        calls.push(args);
        return args[0] === 'status' ? ' M Subsystems/Widget.md\n' : '';
      },
      curator: curator as never,
      accounts: accountsStub,
    });
    svc.setVaultPath(accountId, join(dir, 'commit-vault'));
    svc.writeNote(accountId, 'Subsystems/Widget.md', noteWith(12), 'seed');

    await svc.curateNote(accountId, 'Subsystems/Widget.md');
    // Let the fire-and-forget commit settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls.some((args) => args.includes('commit') && args.includes('Curation'))).toBe(true);
    svc.closeAll();
  });

  it('reports stats over the real vault, and zeroes when unconfigured', () => {
    brain.writeNote(accountId, 'Subsystems/Widget.md', noteWith(12), 'seed');
    brain.writeNote(accountId, 'Subsystems/Short.md', noteWith(2), 'seed');

    const stats = brain.stats(accountId);
    expect(stats.noteCount).toBe(2);
    expect(stats.qualifyingCount).toBe(1);
    expect(stats.totalBytes).toBeGreaterThan(0);

    brain.clearVaultPath(accountId);
    expect(brain.stats(accountId).noteCount).toBe(0);
  });

  it('drains a curation row through the worker', async () => {
    brain.writeNote(accountId, 'Subsystems/Widget.md', noteWith(12), 'seed');
    brain.enqueueCuration(accountId);

    await brain.drainQueue();

    expect(curator).toHaveBeenCalledTimes(1);
    expect(brain.queueCounts(accountId).done).toBe(1);
  });
});
