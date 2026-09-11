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

    it('returns a handful of hits when the caller names no limit', () => {
      // The index default is 20, which is right for the Brain tab's scrollable
      // list and wrong for a tool result: a measured default search returned
      // 20 hits and 27,161 characters, ~6.8K tokens, of which the last seven
      // hits carried no body at all. An explicit limit still overrides this.
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
      // Measured against the real vault: with hits capped at 8 and the shared
      // budget at 10,000, notes six through eight came back with 377, 147 and
      // 133 characters — a heading and two bullets, formatted exactly like a
      // body and answering nothing. The renderer already lists a bodyless hit
      // as one cheap line naming its path, which is strictly more useful.
      const vault = createVault(vaultA);
      for (let i = 0; i < 12; i++) {
        vault.writeNote(`Subsystems/Wide${String(i)}.md`, note(`drain ${'q'.repeat(1900)}`));
      }
      createVaultIndex(join(vaultA, '.omnifex', 'index.db')).rebuild(vault);

      const res = toolsFor(vaultA).search({ query: 'drain' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // Every body that was served had a real budget behind it, so none is a
      // heading and two bullets. The guard is on what is left to spend, which
      // is why a small note served whole is unaffected.
      const served = res.hits.filter((h) => h.body !== null);
      expect(served.length).toBeGreaterThan(0);
      for (const h of served) {
        expect(h.body!.length).toBeGreaterThanOrEqual(MIN_USEFUL_BODY_CHARS);
      }
      expect(res.hits.some((h) => h.body === null)).toBe(true);
      // And the budget still binds, so this is not a licence to overspend.
      const spent = res.hits.reduce((n, h) => n + (h.body?.length ?? 0), 0);
      expect(spent).toBeLessThanOrEqual(MAX_TOTAL_BODY_CHARS);
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

describe('renderSearchResult', () => {
  /** A hit in the shape `search` returns, with only what the renderer reads. */
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
    // Measured on a real response: pretty-printed JSON spent 5,302 of 27,161
    // characters — 20% — on indentation and on escaping the newlines that every
    // markdown note is full of. The model reads markdown either way.
    const text = renderSearchResult('drain', [hit()]);
    expect(text).toContain('## Key facts');
    expect(text).toContain('- drain concurrency is 1');
    expect(text).not.toContain('\\n');
  });

  it('omits the bm25 score', () => {
    // A raw negative float the model cannot calibrate against anything. It was
    // ~7 characters on every hit of every search, forever.
    expect(renderSearchResult('drain', [hit()])).not.toContain('12.5');
  });

  it('names the path of a truncated hit so brain_read needs no guessing', () => {
    const text = renderSearchResult('drain', [hit({ bodyTruncated: true })]);
    expect(text).toContain('brain_read');
    expect(text).toContain('Subsystems/Queue.md');
  });

  it('lists a bodyless hit as one line instead of an empty stub', () => {
    // The old shape returned `body: null, bodyTruncated: true` for every hit
    // past the budget — on a default search, 7 of 20 — which reads as a note
    // whose content was withheld rather than as one simply ranked lower.
    const text = renderSearchResult('drain', [
      hit(),
      hit({ notePath: 'Topics/Later.md', title: 'Later', body: null, bodyTruncated: true }),
    ]);
    expect(text).toContain('Topics/Later.md');
    // Its one line carries the snippet, which is the only thing that can stand
    // in for a body it did not get.
    expect(text).toContain('the [drain] worker');
    const shown = text.slice(text.indexOf('Topics/Later.md'));
    expect(shown.split('\n').length).toBeLessThanOrEqual(3);
  });

  it('says plainly when nothing matched', () => {
    // `[]` is indistinguishable from a broken tool, and the empty-result rate
    // was 44% before the OR fix — the model has met this often.
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
    // `sources` is provenance for the indexer. It is a list of opaque session
    // ids the model can do nothing with, and it grows with every reindex.
    const text = renderNote('Subsystems/Queue.md', parsed);
    expect(text).toContain('Subsystem');
    expect(text).toContain('[[Projects/omnifex]]');
    expect(text).toContain('2026-08-12');
    expect(text).not.toContain('session:abc');
  });
});
