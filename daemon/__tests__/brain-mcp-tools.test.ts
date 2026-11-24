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
  renderSearchResult,
  renderNote,
  MAX_BODY_CHARS,
  MAX_TOTAL_BODY_CHARS,
  MCP_DEFAULT_LIMIT,
  MIN_USEFUL_BODY_CHARS,
  type SearchResultHit,
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
      for (const h of res.hits) {
        if (h.body === null) expect(h.bodyTruncated).toBe(true);
      }
    });

    it('returns a handful of hits when the caller names no limit', () => {
      const vault = createVault(vaultA);
      for (let i = 0; i < 30; i++) {
        vault.writeNote(`Subsystems/Many${String(i)}.md`, note(`drain note ${String(i)}`));
      }
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const tools = toolsFor(vaultA);
      const res = tools.search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.hits.length).toBeLessThanOrEqual(MCP_DEFAULT_LIMIT);

      const wider = tools.search({ query: 'drain', limit: 25 });
      expect(wider.ok).toBe(true);
      if (wider.ok) expect(wider.hits.length).toBeGreaterThan(MCP_DEFAULT_LIMIT);
    });

    it('gives a hit a whole body or an index line, never a fragment', () => {
      const vault = createVault(vaultA);
      for (let i = 0; i < 12; i++) {
        vault.writeNote(`Subsystems/Wide${String(i)}.md`, note(`drain ${'q'.repeat(1900)}`));
      }
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const served = res.hits.filter((h) => h.body !== null);
      expect(served.length).toBeGreaterThan(0);
      for (const h of served) {
        expect(h.body!.length).toBeGreaterThanOrEqual(MIN_USEFUL_BODY_CHARS);
      }
      expect(res.hits.some((h) => h.body === null)).toBe(true);
      const spent = res.hits.reduce((n, h) => n + (h.body?.length ?? 0), 0);
      expect(spent).toBeLessThanOrEqual(MAX_TOTAL_BODY_CHARS);
    });

    it('spends an over-cap body on Key facts and Decisions, not the wikilink dump', () => {
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
      expect(body).not.toMatch(/sections omitted[^)]*Key facts/);
      expect(body).toContain('more in this section');
    });

    it('spends a part-shown section on the lines that match the query', () => {
      const vault = createVault(vaultA);
      const facts = Array.from({ length: 120 }, (_, i) =>
        i === 100 ? '- NEEDLE-LINE the turnOrigin sanitizer moved' : `- FACT-${String(i)} filler detail`,
      );
      vault.writeNote(
        'Subsystems/Deep.md',
        note(['# Deep', '', '## Summary', 'a summary', '', '## Key facts', ...facts, ''].join('\n')),
      );
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const res = toolsFor(vaultA).search({ query: 'turnOrigin' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const deep = res.hits.find((h) => h.notePath === 'Subsystems/Deep.md')!;
      expect(deep.body!.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
      expect(deep.body).toContain('NEEDLE-LINE');
      expect(deep.body).toContain('a summary');
      expect(deep.body).toContain('FACT-0 ');
      expect(deep.body!.indexOf('FACT-0 ')).toBeLessThan(deep.body!.indexOf('NEEDLE-LINE'));
      expect(deep.body).toContain('lines matching the query kept');
      expect(deep.bodyTruncated).toBe(true);
    });

    it('gives a matching section the budget before a non-matching one', () => {
      const vault = createVault(vaultA);
      const decisions = Array.from({ length: 16 }, (_, i) => `- **2026-08-0${String(i % 9)}**: DECISION-${String(i)} ${'d'.repeat(80)}`);
      const facts = Array.from({ length: 60 }, (_, i) =>
        i === 50 ? '- NEEDLE-LINE drainConcurrency is one' : `- FACT-${String(i)} ${'f'.repeat(60)}`,
      );
      vault.writeNote(
        'Subsystems/Crowded.md',
        note(
          [
            '# Crowded', '', '## Summary', 'a summary', '',
            '## Decisions', ...decisions, '',
            '## Key facts', ...facts, '',
          ].join('\n'),
        ),
      );
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const res = toolsFor(vaultA).search({ query: 'drainConcurrency' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const body = res.hits.find((h) => h.notePath === 'Subsystems/Crowded.md')!.body!;
      expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
      expect(body).toContain('NEEDLE-LINE');
      expect(body).toMatch(/sections omitted[^)]*Decisions/);
    });

    it('still keeps a small matching section whole after a large one spills', () => {
      const vault = createVault(vaultA);
      const facts = Array.from({ length: 60 }, (_, i) =>
        i === 1 ? '- NEEDLE-FACT drainConcurrency is one' : `- FACT-${String(i)} ${'f'.repeat(60)}`,
      );
      vault.writeNote(
        'Subsystems/Twice.md',
        note(
          [
            '# Twice', '', '## Summary', 'a summary', '',
            '## Timeline', '- **2026-08-01**: NEEDLE-TIMELINE drainConcurrency set', '',
            '## Key facts', ...facts, '',
          ].join('\n'),
        ),
      );
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const res = toolsFor(vaultA).search({ query: 'drainConcurrency' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const body = res.hits.find((h) => h.notePath === 'Subsystems/Twice.md')!.body!;
      expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
      expect(body).toContain('NEEDLE-FACT');
      expect(body).toContain('NEEDLE-TIMELINE');
    });

    it('condenses exactly as before when no line matches the query', () => {
      const facts = Array.from({ length: 120 }, (_, i) => `- FACT-${String(i)} filler detail`);
      const index = createVaultIndex(join(vaultA, '.omnifex', 'index.db'));
      const vault = createVault(vaultA);
      const body = ['# Zebra', '', '## Summary', 'a summary', '', '## Key facts', ...facts, ''].join('\n');
      vault.writeNote('Subsystems/Zebra.md', note(body));
      index.upsert('Subsystems/Zebra.md', 'Zebra', note(body));
      index.close();

      const res = toolsFor(vaultA).search({ query: 'zebra' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const hit = res.hits.find((h) => h.notePath === 'Subsystems/Zebra.md')!.body!;
      expect(hit).toContain('FACT-0 ');
      expect(hit).toContain('more in this section');
      expect(hit).not.toContain('lines matching the query kept');
    });

    it('drops Connected to from an over-cap body', () => {
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
      rmSync(join(vaultA, 'Subsystems/Gone.md'));

      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const gone = res.hits.find((h) => h.notePath === 'Subsystems/Gone.md');
      expect(gone).toBeDefined();
      expect(gone!.body).toBeNull();
      expect(gone!.bodyTruncated).toBe(true);
      expect(res.hits.find((h) => h.notePath === 'Subsystems/Queue.md')?.body).toBeTruthy();
    });

    it('never carries a body across the vault boundary', () => {
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
      rmSync(join(vaultA, '.omnifex', 'index.db'));
      expect(toolsFor(vaultA).remember({ text: 'still works' }).ok).toBe(true);
      expect(existsSync(join(vaultA, '.omnifex', 'index.db'))).toBe(false);
    });
  });
});

describe('renderSearchResult', () => {
  function hit(over: Partial<SearchResultHit> = {}): SearchResultHit {
    return {
      notePath: 'Subsystems/Queue.md',
      type: 'Subsystem',
      title: 'Queue',
      snippet: 'the [drain] worker',
      score: -12.5,
      body: '## Key facts\n- drain concurrency is 1\n',
      bodyTruncated: false,
      ...over,
    };
  }

  it('renders note text as markdown rather than escaped JSON', () => {
    const text = renderSearchResult('drain', [hit()]);
    expect(text).toContain('## Key facts');
    expect(text).toContain('- drain concurrency is 1');
    expect(text).not.toContain('\\n');
  });

  it('omits the bm25 score', () => {
    expect(renderSearchResult('drain', [hit()])).not.toContain('12.5');
  });

  it('names the path of a truncated hit so brain_read needs no guessing', () => {
    const text = renderSearchResult('drain', [hit({ bodyTruncated: true })]);
    expect(text).toContain('brain_read');
    expect(text).toContain('Subsystems/Queue.md');
  });

  it('lists a bodyless hit as one line instead of an empty stub', () => {
    const text = renderSearchResult('drain', [
      hit(),
      hit({ notePath: 'Topics/Later.md', title: 'Later', body: null, bodyTruncated: true }),
    ]);
    expect(text).toContain('Topics/Later.md');
    expect(text).toContain('the [drain] worker');
    const shown = text.slice(text.indexOf('Topics/Later.md'));
    expect(shown.split('\n').length).toBeLessThanOrEqual(3);
  });

  it('says plainly when nothing matched', () => {
    const text = renderSearchResult('nothing here', []);
    expect(text.toLowerCase()).toContain('no notes');
    expect(text).toContain('nothing here');
    expect(text).not.toBe('[]');
  });

  it('costs far less than the JSON it replaces', () => {
    const hits = Array.from({ length: 8 }, (_, i) =>
      hit({ notePath: `Subsystems/N${String(i)}.md`, body: 'x'.repeat(1200) }),
    );
    const text = renderSearchResult('drain', hits);
    expect(text.length).toBeLessThan(JSON.stringify(hits, null, 2).length);
  });
});

describe('renderNote', () => {
  const parsed: ParsedNote = {
    frontmatter: {
      type: 'Subsystem',
      aliases: ['queue.ts'],
      keywords: ['drain'],
      created: '2026-08-01',
      updated: '2026-08-12',
      sources: ['session:abc'],
      project: '[[Projects/omnifex]]',
    },
    body: '## Key facts\n- drain concurrency is 1\n',
  };

  it('returns the note as markdown, not as an escaped JSON object', () => {
    const text = renderNote('Subsystems/Queue.md', parsed);
    expect(text).toContain('## Key facts');
    expect(text).not.toContain('\\n');
  });

  it('keeps the frontmatter a reader would act on and drops the bookkeeping', () => {
    const text = renderNote('Subsystems/Queue.md', parsed);
    expect(text).toContain('Subsystem');
    expect(text).toContain('[[Projects/omnifex]]');
    expect(text).toContain('2026-08-12');
    expect(text).not.toContain('session:abc');
  });
});
