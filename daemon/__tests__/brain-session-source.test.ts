import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService, type AccountsService } from '../services/accounts';
import { createBrainService } from '../services/brain/registry';
import { createSessionSource } from '../services/brain/sources/session-transcripts';
import { createSourceStateStore } from '../services/brain/sources/state';
import { createBrainSpendStore } from '../services/brain/spend';
import type { BrainSource, DistilledItem } from '../services/brain/sources/types';
import { EXTRACTION_MODEL, type Extractor } from '../services/brain/extract';

const PROMPT = (text: string, i: number): string =>
  JSON.stringify({
    type: 'user',
    uuid: `u${i}`,
    timestamp: `2026-08-01T10:0${i}:00.000Z`,
    cwd: '/Users/dev/Repos/omnifex',
    gitBranch: 'main',
    message: { role: 'user', content: text },
  });

const PROSE = (text: string, i: number): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: `a${i}`,
    timestamp: `2026-08-01T10:0${i}:30.000Z`,
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
  });

const GOOD = [
  PROMPT('first ask', 1),
  PROSE('first answer', 1),
  PROMPT('second ask', 2),
  PROSE('second answer', 2),
].join('\n');

describe('session transcript source', () => {
  let db: Database;
  let accounts: AccountsService;
  let source: BrainSource;
  let dir: string;
  let personalCfg: string;
  let workCfg: string;
  let personalId: number;
  let workId: number;

  function writeSession(
    configDir: string,
    project: string,
    sessionId: string,
    body: string,
  ): string {
    const projectDir = join(configDir, 'projects', project);
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(file, body, 'utf-8');
    return file;
  }

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    dir = mkdtempSync(join(tmpdir(), 'brain-sess-'));
    personalCfg = join(dir, 'personal');
    workCfg = join(dir, 'work');
    personalId = accounts.createAccount({
      name: 'personal',
      configDir: personalCfg,
      engine: 'claude',
    }).id;
    workId = accounts.createAccount({ name: 'work', configDir: workCfg, engine: 'claude' }).id;
    source = createSessionSource({ accounts });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('discover', () => {
    it('attributes a transcript to the account whose config dir holds it', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const items = await source.discover();
      expect(items).toHaveLength(1);
      expect(items[0].accountId).toBe(personalId);
      expect(items[0].sourceId).toBe('session');
      expect(items[0].itemKey).toBe('sess-a');
      expect(items[0].size).toBeGreaterThan(0);
    });

    it('never attributes one account transcript to another', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-personal', GOOD);
      writeSession(workCfg, '-Users-dev-Repos-mango', 'sess-work', GOOD);
      const items = await source.discover();

      const personal = items.filter((i) => i.accountId === personalId);
      const work = items.filter((i) => i.accountId === workId);
      expect(personal.map((i) => i.itemKey)).toEqual(['sess-personal']);
      expect(work.map((i) => i.itemKey)).toEqual(['sess-work']);
      expect(personal.every((i) => i.path.startsWith(personalCfg))).toBe(true);
      expect(work.every((i) => i.path.startsWith(workCfg))).toBe(true);
    });

    it("skips OmniFex's own summary scratch transcripts", async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-real', GOOD);
      writeSession(
        personalCfg,
        '-private-var-folders-xy-T-omnifex-summary-scratch',
        'sess-scratch',
        GOOD,
      );
      const items = await source.discover();
      expect(items.map((i) => i.itemKey)).toEqual(['sess-real']);
    });

    it('ignores sidecar directories and non-jsonl files', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const projectDir = join(personalCfg, 'projects', '-Users-dev-Repos-omnifex');
      mkdirSync(join(projectDir, 'sess-a', 'subagents'), { recursive: true });
      writeFileSync(join(projectDir, 'sess-a', 'subagents', 'agent-1.jsonl'), GOOD, 'utf-8');
      writeFileSync(join(projectDir, 'sess-a.summary.json'), '{}', 'utf-8');
      const items = await source.discover();
      expect(items.map((i) => i.itemKey)).toEqual(['sess-a']);
    });

    it('returns nothing when no config dir exists on disk', async () => {
      await expect(source.discover()).resolves.toEqual([]);
    });

    it('labels an item with its project folder for the Sources pane', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const [item] = await source.discover();
      expect(item.label).toBe('/Users/dev/Repos/omnifex');
    });

    it('recovers a folder whose own name contains a dash', async () => {
      const dashed = GOOD.replace(/\/Users\/dev\/Repos\/omnifex/g, '/Users/dev/Repos/wombeats-ios');
      writeSession(personalCfg, '-Users-dev-Repos-wombeats-ios', 'sess-a', dashed);

      const [item] = await source.discover();

      expect(item.label).toBe('/Users/dev/Repos/wombeats-ios');
    });
  });

  describe('admit', () => {
    const ONE_PROMPT = [PROMPT('just this one', 1), PROSE('an answer', 1)].join('\n');
    const NO_PROSE = [PROMPT('first', 1), PROMPT('second', 2)].join('\n');

    it('admits a session with two prompts and assistant prose', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const [item] = await source.discover();
      const verdict = (await source.admit(item));
      expect(verdict.admitted).toBe(true);
      expect(verdict.reason).toBeTruthy();
    });

    it('skips a session with fewer than two prompts', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', ONE_PROMPT);
      const [item] = await source.discover();
      const verdict = (await source.admit(item));
      expect(verdict.admitted).toBe(false);
      expect(verdict.reason).toContain('prompt');
    });

    it('skips a session with no assistant prose', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', NO_PROSE);
      const [item] = await source.discover();
      expect((await source.admit(item)).admitted).toBe(false);
      expect((await source.admit(item)).reason).toContain('prose');
    });

    it('skips a session that terminated on a startup error', async () => {
      const fixture = readFileSync(
        join(__dirname, 'fixtures', 'brain', 'session-startup-error.jsonl'),
        'utf-8',
      );
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-err', fixture);
      const [item] = await source.discover();
      const verdict = (await source.admit(item));
      expect(verdict.admitted).toBe(false);
      expect(verdict.reason).toContain('error');
    });

    it('skips an unreadable transcript instead of throwing', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const [item] = await source.discover();
      rmSync(item.path);
      await expect(Promise.resolve(source.admit(item))).resolves.toBeDefined();
      expect((await source.admit(item)).admitted).toBe(false);
    });
  });

  describe('distill', () => {
    it('returns bounded prose and metadata for an item', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const [item] = await source.discover();
      const distilled = await source.distill!(item);
      expect(distilled.prose).toContain('USER: first ask');
      expect(distilled.prose).toContain('ASSISTANT: first answer');
      expect(distilled.metadata.kind).toBe('session');
      if (distilled.metadata.kind !== 'session') throw new Error('unreachable');
      expect(distilled.metadata.sessionId).toBe('sess-a');
      expect(distilled.metadata.promptCount).toBe(2);
    });

    it('rejects rather than inventing output when the transcript is gone', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const [item] = await source.discover();
      rmSync(item.path);
      await expect(source.distill!(item)).rejects.toThrow(/cannot read/i);
    });
  });

  describe('BrainService source wiring', () => {
    function service() {
      return createBrainService(db, {
        execGit: async () => '',
        sources: [createSessionSource({ accounts })],
      });
    }

    it('lists sources for one account only, with verdicts and change state', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-personal', GOOD);
      writeSession(workCfg, '-Users-dev-Repos-mango', 'sess-work', GOOD);
      const brain = service();

      const summaries = await brain.listSources(personalId);

      expect(summaries.every((s) => s.accountId === personalId)).toBe(true);
      expect(summaries.map((s) => s.itemKey)).toEqual(['sess-personal']);
      expect(summaries[0]).toMatchObject({ admitted: true, status: null, changed: true });
      brain.closeAll();
    });

    it('will not preview another account item even when the key is known', async () => {
      writeSession(workCfg, '-Users-dev-Repos-mango', 'sess-work', GOOD);
      const brain = service();
      await expect(brain.previewSource(personalId, 'sess-work')).resolves.toBeNull();
      brain.closeAll();
    });

    it('previews the distilled prose of an item it owns', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = service();
      const preview = await brain.previewSource(personalId, 'sess-a');
      expect(preview?.prose).toContain('USER: first ask');
      expect(preview?.admitted).toBe(true);
      expect(preview?.metadata?.kind).toBe('session');
      if (preview?.metadata?.kind !== 'session') throw new Error('unreachable');
      expect(preview.metadata.projectPath).toBe('/Users/dev/Repos/omnifex');
      brain.closeAll();
    });

    it('reports a recorded status back on the next listing', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = service();
      const [before] = await brain.listSources(personalId);
      expect(before.status).toBeNull();

      await createSourceStateStore(db).record(
        {
          sourceId: 'session',
          itemKey: 'sess-a',
          accountId: personalId,
          path: join(personalCfg, 'projects', '-Users-dev-Repos-omnifex', 'sess-a.jsonl'),
          mtimeMs: before.mtimeMs,
          size: 0,
          label: '',
        },
        { status: 'indexed' },
      );

      const [after] = await brain.listSources(personalId);
      expect(after.status).toBe('indexed');
      expect(after.changed).toBe(false);
      brain.closeAll();
    });

    it('carries the folder path through to the summary', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = service();

      const [summary] = await brain.listSources(personalId);

      expect(summary.label).toBe('/Users/dev/Repos/omnifex');
      brain.closeAll();
    });

    it('returns an empty listing for an account with no transcripts', async () => {
      const brain = service();
      await expect(brain.listSources(workId)).resolves.toEqual([]);
      brain.closeAll();
    });
  });

  describe('indexSource', () => {
    const EXTRACTION = {
      entities: [
        {
          type: 'Subsystem' as const,
          name: 'Permission decider',
          aliases: ['decider'],
          keywords: ['permissions'],
          summary: 'The stdio bridge.',
          links: [],
          timelineEntry: 'Reworked the decider.',
          decisions: [],
          keyFacts: [],
        },
      ],
    };

    function stubExtractor(calls: string[] = [], result = EXTRACTION) {
      return async (_item: DistilledItem, configDir: string) => {
        calls.push(configDir);
        return result;
      };
    }

    function service(extractor: Extractor, vaultDir = join(dir, 'personal-vault')) {
      const brain = createBrainService(db, {
        execGit: async () => '',
        accounts,
        extractor,
        sources: [createSessionSource({ accounts })],
      });
      brain.setVaultPath(personalId, vaultDir);
      return brain;
    }

    it('appends what extraction cost to the spend ledger', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const withCost = {
        ...EXTRACTION,
        run: {
          costUsd: 0.017, inputTokens: 900, outputTokens: 120,
          cacheReadTokens: 40, cacheCreationTokens: 5,
        },
      };
      const brain = service(async () => withCost);

      await brain.indexSource(personalId, 'sess-a');

      const rows = createBrainSpendStore(db).byMonth(new Date().toISOString().slice(0, 7));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'index',
        sourceId: 'session',
        itemKey: 'sess-a',
        model: EXTRACTION_MODEL,
        costUsd: 0.017,
        inputTokens: 900,
      });
    });

    it('appends a second row when the same item is indexed again', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const run = {
        costUsd: 0.01, inputTokens: 1, outputTokens: 1,
        cacheReadTokens: null, cacheCreationTokens: null,
      };
      const brain = service(async () => ({ ...EXTRACTION, run }));

      await brain.indexSource(personalId, 'sess-a');
      await brain.indexSource(personalId, 'sess-a', { force: true });

      expect(createBrainSpendStore(db).total(personalId)).toBeCloseTo(0.02, 6);
    });

    it('writes no ledger row for an item that never reached the model', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = service(stubExtractor());

      await brain.indexSource(personalId, 'sess-a');

      expect(createBrainSpendStore(db).total(personalId)).toBe(0);
    });

    it('writes a note into the owning account vault and records the item indexed', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = service(stubExtractor());

      const result = await brain.indexSource(personalId, 'sess-a');

      expect(result.skipped).toBe(false);
      expect(result.notesWritten).toEqual(['Subsystems/Permission decider.md']);
      const note = brain.open(personalId)!.vault.readNote('Subsystems/Permission decider.md');
      expect(note.body).toContain('The stdio bridge.');
      expect(note.frontmatter.sources).toEqual(['session:sess-a']);

      const [row] = createSourceStateStore(db).list(personalId, 'session');
      expect(row.status).toBe('indexed');
      brain.closeAll();
    });

    it('uses the owning account config dir for the extraction call', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const calls: string[] = [];
      const brain = service(stubExtractor(calls));

      await brain.indexSource(personalId, 'sess-a');

      expect(calls).toEqual([personalCfg]);
      brain.closeAll();
    });

    it('refuses to index an item owned by another account', async () => {
      writeSession(workCfg, '-Users-dev-Repos-mango', 'sess-work', GOOD);
      const calls: string[] = [];
      const brain = service(stubExtractor(calls));

      await expect(brain.indexSource(personalId, 'sess-work')).rejects.toThrow(/not found/i);
      expect(calls).toEqual([]);
      brain.closeAll();
    });

    it('skips a gate-rejected item without calling the extractor', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-thin', PROMPT('only one', 1));
      const calls: string[] = [];
      const brain = service(stubExtractor(calls));

      const result = await brain.indexSource(personalId, 'sess-thin');

      expect(result.skipped).toBe(true);
      expect(result.reason).toContain('prompt');
      expect(calls).toEqual([]);
      expect(createSourceStateStore(db).get(personalId, 'session', 'sess-thin')?.status)
        .toBe('skipped');
      brain.closeAll();
    });

    it('records failed with the error when extraction throws, and writes nothing', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = service(async () => { throw new Error('validation blew up'); });

      const result = await brain.indexSource(personalId, 'sess-a');

      expect(result.skipped).toBe(true);
      expect(result.reason).toContain('validation blew up');
      expect(result.notesWritten).toEqual([]);
      expect(brain.open(personalId)!.vault.listNotes()).toEqual([]);

      const row = createSourceStateStore(db).get(personalId, 'session', 'sess-a');
      expect(row?.status).toBe('failed');
      expect(row?.error).toContain('validation blew up');
      brain.closeAll();
    });

    it('is idempotent end to end: indexing twice leaves the note byte-identical', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = service(stubExtractor());
      const notePath = join(dir, 'personal-vault', 'Subsystems', 'Permission decider.md');

      await brain.indexSource(personalId, 'sess-a');
      const first = readFileSync(notePath, 'utf-8');
      await brain.indexSource(personalId, 'sess-a');
      const second = readFileSync(notePath, 'utf-8');

      expect(second).toBe(first);
      brain.closeAll();
    });

    it('indexes an empty extraction without writing a note', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = service(stubExtractor([], { entities: [] }));

      const result = await brain.indexSource(personalId, 'sess-a');

      expect(result.skipped).toBe(false);
      expect(result.notesWritten).toEqual([]);
      expect(createSourceStateStore(db).get(personalId, 'session', 'sess-a')?.status)
        .toBe('indexed');
      brain.closeAll();
    });

    it('does not re-extract an unchanged item that is already indexed', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const calls: string[] = [];
      const brain = service(stubExtractor(calls));

      await brain.indexSource(personalId, 'sess-a');
      const second = await brain.indexSource(personalId, 'sess-a');

      expect(calls).toHaveLength(1);
      expect(second.skipped).toBe(true);
      expect(second.reason).toMatch(/unchanged|already/i);
      brain.closeAll();
    });

    it('re-extracts an unchanged item when forced', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const calls: string[] = [];
      const brain = service(stubExtractor(calls));

      await brain.indexSource(personalId, 'sess-a');
      await brain.indexSource(personalId, 'sess-a', { force: true });

      expect(calls).toHaveLength(2);
      brain.closeAll();
    });

    it('re-extracts when the transcript itself changed', async () => {
      const file = writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const calls: string[] = [];
      const brain = service(stubExtractor(calls));

      await brain.indexSource(personalId, 'sess-a');
      writeFileSync(file, `${GOOD}\n${PROSE('a later reply', 3)}`, 'utf-8');
      await brain.indexSource(personalId, 'sess-a');

      expect(calls).toHaveLength(2);
      brain.closeAll();
    });

    it('folds a later differently-named entity into the existing note', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-b', GOOD);
      let call = 0;
      const brain = service(async () => {
        call += 1;
        return {
          entities: [
            call === 1
              ? { type: 'Subsystem' as const, name: 'Brain memory vault',
                  aliases: ['omnifex-brain-vault'], keywords: [], summary: 'first',
                  links: [], decisions: [], keyFacts: [] }
              : { type: 'Subsystem' as const, name: 'omnifex-brain-vault',
                  aliases: [], keywords: [], summary: 'second',
                  links: [], decisions: [], keyFacts: [] },
          ],
        };
      });

      await brain.indexSource(personalId, 'sess-a');
      const second = await brain.indexSource(personalId, 'sess-b');

      expect(second.notesWritten).toEqual(['Subsystems/Brain memory vault.md']);
      expect(brain.open(personalId)!.vault.listNotes()).toEqual([
        'Subsystems/Brain memory vault.md',
      ]);
      const note = brain.open(personalId)!.vault.readNote('Subsystems/Brain memory vault.md');
      expect(note.frontmatter.sources).toEqual(['session:sess-a', 'session:sess-b']);
      brain.closeAll();
    });

    it('still creates a separate note for a genuinely different entity', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-b', GOOD);
      let call = 0;
      const brain = service(async () => {
        call += 1;
        return {
          entities: [
            { type: 'Subsystem' as const,
              name: call === 1 ? 'Brain memory vault' : 'Distiller',
              aliases: [], keywords: [], summary: 'x',
              links: [], decisions: [], keyFacts: [] },
          ],
        };
      });

      await brain.indexSource(personalId, 'sess-a');
      await brain.indexSource(personalId, 'sess-b');

      expect(brain.open(personalId)!.vault.listNotes().sort()).toEqual([
        'Subsystems/Brain memory vault.md',
        'Subsystems/Distiller.md',
      ]);
      brain.closeAll();
    });

    it('tells the extractor which entities the vault already holds', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-b', GOOD);
      const seen: string[][] = [];
      const brain = createBrainService(db, {
        execGit: async () => '',
        accounts,
        extractor: async (_item, _cfg, ctx) => {
          seen.push(ctx?.existingNames ?? []);
          return {
            entities: [
              { type: 'Subsystem' as const, name: 'Brain memory vault', aliases: [],
                keywords: [], summary: 'x', links: [], decisions: [], keyFacts: [] },
            ],
          };
        },
        sources: [createSessionSource({ accounts })],
      });
      brain.setVaultPath(personalId, join(dir, 'personal-vault'));

      await brain.indexSource(personalId, 'sess-a');
      await brain.indexSource(personalId, 'sess-b');

      expect(seen[0]).toEqual([]);
      expect(seen[1]).toContain('Brain memory vault');
      brain.closeAll();
    });

    it('isolates a bad entity: writes the others and records the failure', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = service(async () => ({
        entities: [
          // `..` survives schema normalization but vault.ts rejects it.
          { type: 'Topic' as const, name: '..', aliases: [], keywords: [],
            summary: 'bad', links: [], decisions: [], keyFacts: [] },
          { type: 'Subsystem' as const, name: 'Good One', aliases: [], keywords: [],
            summary: 'fine', links: [], decisions: [], keyFacts: [] },
        ],
      }));

      const result = await brain.indexSource(personalId, 'sess-a');

      expect(result.notesWritten).toEqual(['Subsystems/Good One.md']);
      expect(result.reason).toMatch(/1 entit/i);
      const row = createSourceStateStore(db).get(personalId, 'session', 'sess-a');
      expect(row?.status).toBe('indexed');
      expect(row?.error).toContain('..');
      brain.closeAll();
    });

    it('never throws out of indexSource for a wholly unusable extraction', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = service(async () => ({
        entities: [
          { type: 'Topic' as const, name: '..', aliases: [], keywords: [],
            summary: 'bad', links: [], decisions: [], keyFacts: [] },
        ],
      }));
      const result = await brain.indexSource(personalId, 'sess-a');
      expect(result.notesWritten).toEqual([]);
      expect(result.skipped).toBe(true);
      brain.closeAll();
    });

    it('backfill enqueues admitted items and skips gate-rejected ones', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-good', GOOD);
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-thin', PROMPT('only one', 1));
      const brain = service(stubExtractor());

      const queued = await brain.backfill(personalId);

      expect(queued).toBe(1);
      expect(brain.queueList(personalId).map((e) => e.itemKey)).toEqual(['sess-good']);
      brain.closeAll();
    });

    it('backfill skips items already indexed and unchanged', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = service(stubExtractor());
      await brain.indexSource(personalId, 'sess-a');

      await expect(brain.backfill(personalId)).resolves.toBe(0);
      brain.closeAll();
    });

    it('backfill only touches the account it was given', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-personal', GOOD);
      writeSession(workCfg, '-Users-dev-Repos-mango', 'sess-work', GOOD);
      const brain = service(stubExtractor());

      await brain.backfill(personalId);

      expect(brain.queueList(personalId).map((e) => e.itemKey)).toEqual(['sess-personal']);
      expect(brain.queueList(workId)).toEqual([]);
      brain.closeAll();
    });

    it('enqueueSource refuses an item owned by another account', async () => {
      writeSession(workCfg, '-Users-dev-Repos-mango', 'sess-work', GOOD);
      const brain = service(stubExtractor());
      await expect(brain.enqueueSource(personalId, 'sess-work')).rejects.toThrow(/not found/i);
      brain.closeAll();
    });

    it('drainQueue runs the queued items through indexSource', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const calls: string[] = [];
      const brain = service(stubExtractor(calls));

      await brain.backfill(personalId);
      await brain.drainQueue();

      expect(calls).toHaveLength(1);
      expect(brain.queueCounts(personalId)).toMatchObject({ pending: 0, done: 1 });
      brain.closeAll();
    });

    it('drainQueue indexes other sessions while one is still open', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-live', GOOD);
      const calls: string[] = [];
      const brain = createBrainService(db, {
        execGit: async () => '',
        accounts,
        extractor: stubExtractor(calls),
        sources: [createSessionSource({ accounts })],
        liveSessionIds: () => ['sess-live'],
      });
      brain.setVaultPath(personalId, join(dir, 'personal-vault'));

      await brain.backfill(personalId);
      await brain.drainQueue();

      expect(calls).toHaveLength(1);
      brain.closeAll();
    });

    it('throws when the owning account has no vault configured', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = createBrainService(db, {
        execGit: async () => '',
        accounts,
        extractor: stubExtractor(),
        sources: [createSessionSource({ accounts })],
      });
      await expect(brain.indexSource(personalId, 'sess-a')).rejects.toThrow(/vault/i);
      brain.closeAll();
    });

    it('throws rather than silently no-opping when no extractor is wired', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = createBrainService(db, {
        execGit: async () => '',
        accounts,
        sources: [createSessionSource({ accounts })],
      });
      brain.setVaultPath(personalId, join(dir, 'personal-vault'));
      await expect(brain.indexSource(personalId, 'sess-a')).rejects.toThrow(/extractor/i);
      brain.closeAll();
    });
  });
});

describe('session transcript source — one session, many files', () => {
  let db: Database;
  let accounts: AccountsService;
  let source: BrainSource;
  let dir: string;
  let cfg: string;

  const WORKTREE = '-Users-dev-Repos-omnifex--claude-worktrees-PI-272';
  const MAIN = '-Users-dev-Repos-omnifex';

  function write(project: string, sessionId: string, body: string, mtimeMs?: number): string {
    const projectDir = join(cfg, 'projects', project);
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(file, body, 'utf-8');
    if (mtimeMs !== undefined) {
      const when = new Date(mtimeMs);
      utimesSync(file, when, when);
    }
    return file;
  }

  beforeEach(() => {
    db = createDatabase(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'omnifex-multi-file-'));
    cfg = join(dir, 'personal');
    mkdirSync(cfg, { recursive: true });
    accounts = createAccountsService(db);
    accounts.createAccount({ name: 'personal', configDir: cfg, engine: 'claude' });
    source = createSessionSource({ accounts });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const EARLIER = Date.parse('2026-07-14T03:28:36.000Z');
  const LATER = Date.parse('2026-07-14T03:28:45.000Z');

  it('emits one item for a session split across two project directories', async () => {
    write(WORKTREE, 'sess-split', GOOD, EARLIER);
    write(MAIN, 'sess-split', GOOD, LATER);

    const items = await source.discover();
    expect(items).toHaveLength(1);
    expect(items[0].itemKey).toBe('sess-split');
  });

  it('carries every backing file, oldest first', async () => {
    const older = write(WORKTREE, 'sess-split', GOOD, EARLIER);
    const newer = write(MAIN, 'sess-split', GOOD, LATER);

    const [item] = await source.discover();
    expect(item.paths).toEqual([older, newer]);
  });

  it('reports the newest file as its primary path, size as the whole session', async () => {
    write(WORKTREE, 'sess-split', GOOD, EARLIER);
    const newer = write(MAIN, 'sess-split', GOOD, LATER);

    const [item] = await source.discover();
    expect(item.path).toBe(newer);
    expect(item.mtimeMs).toBe(LATER);
    expect(item.size).toBe(Buffer.byteLength(GOOD) * 2);
  });

  it('still emits one item per file when the ids differ', async () => {
    write(MAIN, 'sess-a', GOOD, EARLIER);
    write(MAIN, 'sess-b', GOOD, LATER);
    const items = await source.discover();
    expect(items.map((i) => i.itemKey).sort()).toEqual(['sess-a', 'sess-b']);
    expect(items.every((i) => i.paths?.length === 1)).toBe(true);
  });

  it('never merges the same id across two accounts', async () => {
    const otherCfg = join(dir, 'work');
    mkdirSync(join(otherCfg, 'projects', MAIN), { recursive: true });
    writeFileSync(join(otherCfg, 'projects', MAIN, 'sess-split.jsonl'), GOOD, 'utf-8');
    accounts.createAccount({ name: 'work', configDir: otherCfg, engine: 'claude' });
    write(MAIN, 'sess-split', GOOD, EARLIER);

    const items = await source.discover();
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.accountId)).size).toBe(2);
    for (const item of items) expect(item.paths).toHaveLength(1);
  });

  it('distils the whole conversation, not just one half', async () => {
    write(WORKTREE, 'sess-split', [PROMPT('from the worktree', 1), PROSE('answer one', 1)].join('\n'), EARLIER);
    write(MAIN, 'sess-split', [PROMPT('from the checkout', 2), PROSE('answer two', 2)].join('\n'), LATER);

    const [item] = await source.discover();
    const distilled = await source.distill!(item);
    expect(distilled.prose).toContain('from the worktree');
    expect(distilled.prose).toContain('from the checkout');
  });

  it('admits on the combined transcript, not on either half alone', async () => {
    write(WORKTREE, 'sess-split', [PROMPT('only ask here', 1), PROSE('answer one', 1)].join('\n'), EARLIER);
    write(MAIN, 'sess-split', [PROMPT('only ask there', 2), PROSE('answer two', 2)].join('\n'), LATER);

    const [item] = await source.discover();
    expect((await source.admit(item)).admitted).toBe(true);
  });
});

describe('session transcript source — change detection across files', () => {
  let db: Database;
  let accounts: AccountsService;
  let source: BrainSource;
  let dir: string;
  let cfg: string;

  function write(project: string, sessionId: string, body: string, mtimeMs: number): string {
    const projectDir = join(cfg, 'projects', project);
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(file, body, 'utf-8');
    const when = new Date(mtimeMs);
    utimesSync(file, when, when);
    return file;
  }

  beforeEach(() => {
    db = createDatabase(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'omnifex-multi-change-'));
    cfg = join(dir, 'personal');
    mkdirSync(cfg, { recursive: true });
    accounts = createAccountsService(db);
    accounts.createAccount({ name: 'personal', configDir: cfg, engine: 'claude' });
    source = createSessionSource({ accounts });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const EARLIER = Date.parse('2026-07-14T03:28:36.000Z');
  const LATER = Date.parse('2026-07-14T03:28:45.000Z');

  it('hashes every file, so a change in an older half is not read as unchanged', async () => {
    const older = write('-Users-dev-a', 'sess-split', GOOD, EARLIER);
    const newest = write('-Users-dev-b', 'sess-split', GOOD, LATER);
    const store = createSourceStateStore(db);

    const [before] = await source.discover();
    await store.record(before, { status: 'indexed' });
    expect(await store.hasChanged(before)).toBe(false);

    // Touching the newest file gets past the mtime fast path; only the hash can
    // notice the older half moved.
    writeFileSync(older, `${GOOD}\n${PROMPT('a third ask', 3)}`, 'utf-8');
    const keepOld = new Date(EARLIER);
    utimesSync(older, keepOld, keepOld);
    const touched = new Date(LATER + 60_000);
    utimesSync(newest, touched, touched);

    const [after] = await source.discover();
    expect(after.path).toBe(newest);
    expect(await store.hasChanged(after)).toBe(true);
  });
});
