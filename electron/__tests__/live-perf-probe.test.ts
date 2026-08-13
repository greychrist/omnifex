import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../services/database';
import { createBrainService } from '../services/brain/registry';
import { createAutoMemorySource } from '../services/brain/sources/auto-memory';
import { createVaultGit } from '../services/brain/git';
import type { AccountsService } from '../services/accounts';

/** TEMPORARY perf probe — deleted after the run. Spends nothing. */

const CONFIG_DIR = '/Users/gregorychristie/.claude-personal';

function time(label: string, fn: () => unknown, runs = 5): string {
  const times: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const t = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  return `${label}: avg ${avg.toFixed(1)}ms  (${times.map((t) => t.toFixed(1)).join(', ')})`;
}

describe('LIVE perf probe', () => {
  it('times what an account switch costs in the main process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-perf-'));
    const db = createDatabase(':memory:');
    db.raw
      .prepare(
        `INSERT INTO accounts (id, name, config_dir, engine, subscription_label, has_cost)
         VALUES (1, 'personal', ?, 'claude', 'Max', 0)`,
      )
      .run(CONFIG_DIR);
    const accounts = {
      listAccounts: () => [{ id: 1, name: 'personal', config_dir: CONFIG_DIR }],
    } as unknown as AccountsService;

    const brain = createBrainService(db, {
      accounts,
      execGit: async () => '',
      sources: [createAutoMemorySource({ accounts })],
    });
    brain.setVaultPath(1, join(dir, 'vault'));

    for (const s of (await brain.listSources(1)).filter((x) => x.admitted)) {
      await brain.indexSource(1, s.itemKey);
    }

    const lines = [
      `notes in vault: ${String(brain.stats(1).noteCount)}`,
      '',
      '--- what an account switch fires ---',
      time('brainListNotes (readdir only)', () => brain.open(1)?.vault.listNotes()),
      time('brainStats     (read+parse every note)', () => brain.stats(1)),
      '',
      '--- for scale: 10x the corpus ---',
    ];

    // 83 notes is a young vault. Project the cost at a realistic size by
    // timing the per-note work directly.
    const handle = brain.open(1);
    const paths = handle?.vault.listNotes() ?? [];
    lines.push(
      time('readNote x N (parse only)', () => {
        for (const p of paths) handle?.vault.readNote(p);
      }),
    );

    // The one call an account switch ALWAYS makes, via useBrainVault.load().
    lines.push('', '--- brainStatus, the first call of every switch ---');
    const statusTimes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t = process.hrtime.bigint();
      await brain.status(1);
      statusTimes.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    lines.push(
      `brainStatus: avg ${(statusTimes.reduce((a, b) => a + b, 0) / statusTimes.length).toFixed(1)}ms` +
        `  (${statusTimes.map((t) => t.toFixed(1)).join(', ')})`,
    );

    const gitTimes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t = process.hrtime.bigint();
      await createVaultGit(process.cwd()).available();
      gitTimes.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    lines.push(
      '  of which git --version spawn: avg ' +
        `${(gitTimes.reduce((a, b) => a + b, 0) / gitTimes.length).toFixed(1)}ms` +
        `  (${gitTimes.map((t) => t.toFixed(1)).join(', ')})`,
    );

    const report = lines.join('\n');
    writeFileSync('/tmp/perf-probe.txt', report, 'utf8');
    expect(paths.length).toBeGreaterThan(0);

    brain.closeAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }, 300_000);
});
