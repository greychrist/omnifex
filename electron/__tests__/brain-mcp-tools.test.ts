import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVault } from '../services/brain/vault';
import { createVaultIndex, openVaultIndexReadOnly } from '../services/brain/search';
import {
  createBrainMcpTools,
  MAX_BODY_CHARS,
  MAX_TOTAL_BODY_CHARS,
} from '../services/brain/mcp-tools';
import type { ParsedNote } from '../services/brain/types';

function note(body: string, project?: string): ParsedNote {
  return {
    frontmatter: {
      type: 'Subsystem',
      aliases: [],
      keywords: [],
      created: '2026-08-12',
      updated: '2026-08-12',
      sources: [],
      ...(project ? { project } : {}),
    },
    body,
  };
}

/**
 * A note in the seven-section shape merge.ts renders, sized past MAX_BODY_CHARS
 * with the bulk sitting in `Connected to` — the real shape of the vault's
 * largest notes, where wikilinks and Key facts crowd out everything a prefix
 * slice would reach.
 */
function sectioned(): string {
  const links = Array.from({ length: 80 }, (_, i) => `- [[Subsystems/WIKILINK-MARKER-${String(i)}]]`);
  return [
    '# Big',
    '',
    '## Summary',
    'SUMMARY-MARKER the drain worker yields to interactive sessions.',
    '',
    '## Connected to',
    ...links,
    '',
    '## Timeline',
    '- **2026-08-01**: TIMELINE-MARKER wired the queue.',
    '',
    '## Decisions',
    '- **2026-08-01**: DECISION-MARKER one worker drains, never two.',
    '',
    '## Key facts',
    '- KEYFACT-MARKER drain concurrency is 1',
    '',
    '## Open items',
    '',
    '## Assistant notes',
    '',
  ].join('\n');
}

/** A tools instance bound to one vault, exactly as the server process binds one. */
function toolsFor(root: string) {
  let n = 0;
  return createBrainMcpTools({
    vault: createVault(root),
    openIndex: () => openVaultIndexReadOnly(join(root, '.omnifex', 'index.db')),
    captureDir: join(root, '.omnifex', 'capture'),
    newId: () => `cap-${String(++n)}`,
    now: () => new Date('2026-08-12T18:00:00.000Z'),
  });
}

describe('brain MCP tools', () => {
  let tmp: string;
  let vaultA: string;
  let vaultB: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-mcp-'));
    vaultA = join(tmp, 'A');
    vaultB = join(tmp, 'B');

    // Two vaults wired up in one test, deliberately. Isolation between them is
    // the property whose failure is a confidentiality breach rather than a bug,
    // so it is asserted against a real second vault, not an assumption.
    for (const [root, body] of [
      [vaultA, 'the drain worker yields to interactive sessions'],
      [vaultB, 'work-account material nobody else may read'],
    ] as const) {
      mkdirSync(root, { recursive: true });
      const vault = createVault(root);
      vault.ensureLayout();
      vault.writeNote(
        root === vaultA ? 'Subsystems/Queue.md' : 'Subsystems/Secret.md',
        note(body, root === vaultA ? '[[Projects/omnifex]]' : undefined),
      );
      const index = createVaultIndex(join(root, '.omnifex', 'index.db'));
      index.rebuild(vault);
      index.close();
    }
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('search', () => {
    it('finds a note in its own vault', () => {
      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.hits.map((h) => h.notePath)).toEqual(['Subsystems/Queue.md']);
    });

    it('never returns a note from the vault it was not handed', () => {
      const res = toolsFor(vaultA).search({ query: 'work-account' });
      expect(res).toEqual({ ok: true, hits: [] });
    });

    it('carries the note body so a hit is usable without a second call', () => {
      // The point of the whole thing: a snippet-only hit forces a brain_read
      // round trip per note, and in practice the model answers off the
      // truncated snippet instead of making it.
      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.hits[0].body).toBe('the drain worker yields to interactive sessions');
      expect(res.hits[0].bodyTruncated).toBe(false);
    });

    it('caps a long body and flags it so the model knows to read the rest', () => {
      const vault = createVault(vaultA);
      vault.writeNote('Subsystems/Long.md', note(`drain ${'x'.repeat(5000)}`));
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const long = res.hits.find((h) => h.notePath === 'Subsystems/Long.md');
      expect(long).toBeDefined();
      expect(long!.body!.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
      expect(long!.bodyTruncated).toBe(true);
    });

    it('stops spending body budget once the response is already large', () => {
      // `limit` allows 50 hits. Without a ceiling across the whole response,
      // 50 long notes would bury the caller in one tool result.
      const vault = createVault(vaultA);
      for (let i = 0; i < 30; i++) {
        vault.writeNote(`Subsystems/Bulk${String(i)}.md`, note(`drain ${'y'.repeat(1900)}`));
      }
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const res = toolsFor(vaultA).search({ query: 'drain', limit: 30 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const spent = res.hits.reduce((n, h) => n + (h.body?.length ?? 0), 0);
      expect(spent).toBeLessThanOrEqual(MAX_TOTAL_BODY_CHARS);
      // Whatever got no body must say so, or the caller reads a partial set as
      // if it were the whole thing.
      for (const h of res.hits) {
        if (h.body === null) expect(h.bodyTruncated).toBe(true);
      }
    });

    it('spends an over-cap body on Key facts and Decisions, not the wikilink dump', () => {
      // The failure this prevents, measured on the real vault: Projects/OmniFex.md
      // is 25KB whose first 2000 characters are Summary plus a truncated
      // `Connected to` list. A prefix slice therefore answered every search with
      // navigation links and no content — confidently formatted and useless.
      const vault = createVault(vaultA);
      vault.writeNote('Subsystems/Big.md', note(sectioned()));
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const big = res.hits.find((h) => h.notePath === 'Subsystems/Big.md');
      expect(big).toBeDefined();
      expect(big!.body!.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
      expect(big!.bodyTruncated).toBe(true);
      expect(big!.body).toContain('KEYFACT-MARKER');
      expect(big!.body).toContain('DECISION-MARKER');
      expect(big!.body).toContain('SUMMARY-MARKER');
    });

    it('fills the budget with part of a section too large to fit whole', () => {
      // Measured on the real vault: Key facts is 14KB of Projects/OmniFex.md's
      // 25KB. Keeping only sections that fit entire leaves that note spending
      // 560 of its 2000 characters on the Summary and dropping every fact.
      const vault = createVault(vaultA);
      const facts = Array.from({ length: 120 }, (_, i) => `- FACT-${String(i)} drain detail`);
      vault.writeNote(
        'Subsystems/Fat.md',
        note(['# Fat', '', '## Summary', 'drain summary', '', '## Key facts', ...facts, ''].join('\n')),
      );
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const fat = res.hits.find((h) => h.notePath === 'Subsystems/Fat.md')!;
      expect(fat.body!.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
      // The whole point: most of the budget goes to facts, not to whitespace.
      expect(fat.body!.length).toBeGreaterThan(MAX_BODY_CHARS * 0.8);
      expect(fat.body).toContain('## Key facts');
      expect(fat.body).toContain('FACT-0');
      expect(fat.bodyTruncated).toBe(true);
    });

    it('marks a part-shown section as cut rather than listing it as omitted', () => {
      const vault = createVault(vaultA);
      const facts = Array.from({ length: 120 }, (_, i) => `- FACT-${String(i)} drain detail`);
      vault.writeNote(
        'Subsystems/Fat.md',
        note(['# Fat', '', '## Summary', 'drain summary', '', '## Key facts', ...facts, ''].join('\n')),
      );
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const body = res.hits.find((h) => h.notePath === 'Subsystems/Fat.md')!.body!;
      // Saying "Key facts omitted" while showing 40 of them would be a lie.
      expect(body).not.toMatch(/sections omitted[^)]*Key facts/);
      expect(body).toContain('more in this section');
    });

    it('drops Connected to from an over-cap body', () => {
      // Wikilinks are navigation, not content. They are the single largest
      // thing standing between the cap and the sections that answer a query.
      const vault = createVault(vaultA);
      vault.writeNote('Subsystems/Big.md', note(sectioned()));
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const body = res.hits.find((h) => h.notePath === 'Subsystems/Big.md')!.body!;
      expect(body).not.toContain('WIKILINK-MARKER');
      expect(body).not.toContain('## Connected to');
    });

    it('names the sections it left out so an omission does not read as an empty one', () => {
      // Every note has all seven sections by construction (merge.ts SECTION_ORDER),
      // so a silently missing one reads as "nothing to say" rather than "not shown".
      const vault = createVault(vaultA);
      vault.writeNote('Subsystems/Big.md', note(sectioned()));
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const body = res.hits.find((h) => h.notePath === 'Subsystems/Big.md')!.body!;
      expect(body).toContain('sections omitted');
      expect(body).toContain('Connected to');
    });

    it('serves a body that fits verbatim, Connected to and all', () => {
      // Condensing is a response to the cap, not a rewrite of every note. Over
      // half the vault fits, and those hits must keep arriving whole.
      const vault = createVault(vaultA);
      const small = '# Small\n\n## Connected to\n- [[Projects/omnifex]]\n\n## Key facts\n- drain fact\n';
      vault.writeNote('Subsystems/Small.md', note(small));
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const hit = res.hits.find((h) => h.notePath === 'Subsystems/Small.md');
      expect(hit!.body).toBe(small);
      expect(hit!.bodyTruncated).toBe(false);
    });

    it('falls back to a prefix for an over-cap body with no sections at all', () => {
      // Auto-memory translations carry prose with no `## ` headings. Section
      // selection has nothing to select, and must not return an empty body.
      const vault = createVault(vaultA);
      vault.writeNote('Notes/Freeform.md', note(`drain ${'z'.repeat(5000)}`));
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const free = res.hits.find((h) => h.notePath === 'Notes/Freeform.md');
      expect(free!.body!.length).toBeGreaterThan(MAX_BODY_CHARS / 2);
      expect(free!.body!.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
      expect(free!.body!.startsWith('drain zzz')).toBe(true);
      expect(free!.bodyTruncated).toBe(true);
    });

    it('degrades one unreadable note to a flagged hit instead of failing the search', () => {
      const vault = createVault(vaultA);
      vault.writeNote('Subsystems/Gone.md', note('drain me'));
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);
      // Indexed, then removed underneath — the index is a snapshot, so this is
      // an ordinary race, not a corrupted vault.
      rmSync(join(vaultA, 'Subsystems/Gone.md'));

      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const gone = res.hits.find((h) => h.notePath === 'Subsystems/Gone.md');
      expect(gone).toBeDefined();
      expect(gone!.body).toBeNull();
      expect(gone!.bodyTruncated).toBe(true);
      // The healthy hit in the same response still carries its body.
      expect(res.hits.find((h) => h.notePath === 'Subsystems/Queue.md')?.body).toBeTruthy();
    });

    it('never carries a body across the vault boundary', () => {
      // Bodies are new surface on the isolation property: `notePath` leaking
      // would be bad, a body leaking would be worse.
      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      for (const h of res.hits) {
        expect(h.body ?? '').not.toContain('work-account material');
      }
    });

    it('filters by project', () => {
      const t = toolsFor(vaultA);
      const mine = t.search({ query: 'drain', project: '[[Projects/omnifex]]' });
      expect(mine.ok && mine.hits).toHaveLength(1);
      const other = t.search({ query: 'drain', project: '[[Projects/win]]' });
      expect(other.ok && other.hits).toEqual([]);
    });

    it('filters by type', () => {
      const res = toolsFor(vaultA).search({ query: 'drain', type: 'Topic' });
      expect(res.ok && res.hits).toEqual([]);
    });

    it('reports a missing index as a tool error rather than throwing', () => {
      rmSync(join(vaultA, '.omnifex', 'index.db'));
      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('Brain index');
    });

    it('closes the index it opened on every call', () => {
      // A held-open handle would keep reading an unlinked inode after a
      // rebuild from the Brain tab replaces the file.
      const t = toolsFor(vaultA);
      t.search({ query: 'drain' });
      const index = createVaultIndex(join(vaultA, '.omnifex', 'index.db'));
      index.upsert('Topics/New.md', 'New', note('freshly added'));
      index.close();
      const res = t.search({ query: 'freshly' });
      expect(res.ok && res.hits.map((h) => h.notePath)).toEqual(['Topics/New.md']);
    });
  });

  describe('read', () => {
    it('reads a note whole', () => {
      const res = toolsFor(vaultA).read({ path: 'Subsystems/Queue.md' });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.note.body).toContain('drain worker');
    });

    it('reads notes even when the index is gone', () => {
      rmSync(join(vaultA, '.omnifex', 'index.db'));
      expect(toolsFor(vaultA).read({ path: 'Subsystems/Queue.md' }).ok).toBe(true);
    });

    it('refuses a path that escapes the vault', () => {
      const res = toolsFor(vaultA).read({ path: '../B/Subsystems/Secret.md' });
      expect(res.ok).toBe(false);
    });

    it('surfaces a broken note as an error, not a crash', () => {
      writeFileSync(join(vaultA, 'Subsystems', 'Broken.md'), '---\ntype: [unclosed\n---\nbody\n');
      const res = toolsFor(vaultA).read({ path: 'Subsystems/Broken.md' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('cannot read note');
    });

    it('reports a missing note as an error', () => {
      expect(toolsFor(vaultA).read({ path: 'Subsystems/Absent.md' }).ok).toBe(false);
    });
  });

  describe('remember', () => {
    it('writes one capture file per call', () => {
      const t = toolsFor(vaultA);
      expect(t.remember({ text: 'node-pty must stay on the beta', project: 'omnifex', cwd: '/repo' }))
        .toEqual({ ok: true, id: 'cap-1' });
      expect(t.remember({ text: 'second thought' })).toEqual({ ok: true, id: 'cap-2' });

      const dir = join(vaultA, '.omnifex', 'capture');
      expect(readdirSync(dir).sort()).toEqual(['cap-1.json', 'cap-2.json']);
      expect(JSON.parse(readFileSync(join(dir, 'cap-1.json'), 'utf8'))).toEqual({
        id: 'cap-1',
        text: 'node-pty must stay on the beta',
        project: 'omnifex',
        cwd: '/repo',
        capturedAt: '2026-08-12T18:00:00.000Z',
      });
    });

    it('trims the captured text and rejects an empty one', () => {
      const t = toolsFor(vaultA);
      expect(t.remember({ text: '   ' }).ok).toBe(false);
      // A rejected capture must not consume an id — ids are the capture's
      // itemKey, and a gap would look like a lost capture in the queue.
      expect(t.remember({ text: '  padded  ' })).toEqual({ ok: true, id: 'cap-1' });
      const file = JSON.parse(
        readFileSync(join(vaultA, '.omnifex', 'capture', 'cap-1.json'), 'utf8'),
      ) as { text: string };
      expect(file.text).toBe('padded');
    });

    it('records absent optional fields as null rather than omitting them', () => {
      toolsFor(vaultA).remember({ text: 'bare' });
      const file = JSON.parse(
        readFileSync(join(vaultA, '.omnifex', 'capture', 'cap-1.json'), 'utf8'),
      ) as { project: unknown; cwd: unknown };
      expect(file).toMatchObject({ project: null, cwd: null });
    });

    it('never writes a capture into the other vault', () => {
      toolsFor(vaultA).remember({ text: 'x' });
      expect(existsSync(join(vaultB, '.omnifex', 'capture'))).toBe(false);
    });

    it('does not touch SQLite', () => {
      // The capture path is the reason the MCP process can open the DB
      // read-only at all; a write here would reintroduce the contention.
      rmSync(join(vaultA, '.omnifex', 'index.db'));
      expect(toolsFor(vaultA).remember({ text: 'still works' }).ok).toBe(true);
      expect(existsSync(join(vaultA, '.omnifex', 'index.db'))).toBe(false);
    });
  });
});
