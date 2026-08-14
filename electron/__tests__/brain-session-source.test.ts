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

/** A transcript that clears the gate: two prompts and assistant prose. */
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

      // The isolation property, asserted with two accounts in one test because
      // its failure is a confidentiality breach rather than a bug (spec §Testing).
      const personal = items.filter((i) => i.accountId === personalId);
      const work = items.filter((i) => i.accountId === workId);
      expect(personal.map((i) => i.itemKey)).toEqual(['sess-personal']);
      expect(work.map((i) => i.itemKey)).toEqual(['sess-work']);
      expect(personal.every((i) => i.path.startsWith(personalCfg))).toBe(true);
      expect(work.every((i) => i.path.startsWith(workCfg))).toBe(true);
    });

    it("skips OmniFex's own summary scratch transcripts", async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-real', GOOD);
      // The CLI encodes <tmpdir>/omnifex-summary-scratch into a projects dir
      // like any other cwd. These are OmniFex talking to itself; indexing them
      // would fill the Brain with its own summary calls.
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
      // Real layout: <sessionId>/subagents/ and <sessionId>/tool-results/ sit
      // beside the transcript, and *.summary.json sidecars beside that.
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

    /**
     * The label is recovered from the transcript's own `cwd`, never decoded
     * from the encoded dir name: that encoding is lossy, and a folder whose
     * name contains a dash decodes to a path that does not exist.
     */
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
      const verdict = source.admit(item);
      expect(verdict.admitted).toBe(true);
      expect(verdict.reason).toBeTruthy();
    });

    it('skips a session with fewer than two prompts', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', ONE_PROMPT);
      const [item] = await source.discover();
      const verdict = source.admit(item);
      expect(verdict.admitted).toBe(false);
      // The reason is what the Sources pane shows, so it has to name the rule
      // that fired rather than just say "skipped".
      expect(verdict.reason).toContain('prompt');
    });

    it('skips a session with no assistant prose', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', NO_PROSE);
      const [item] = await source.discover();
      expect(source.admit(item).admitted).toBe(false);
      expect(source.admit(item).reason).toContain('prose');
    });

    it('skips a session that terminated on a startup error', async () => {
      const fixture = readFileSync(
        join(__dirname, 'fixtures', 'brain', 'session-startup-error.jsonl'),
        'utf-8',
      );
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-err', fixture);
      const [item] = await source.discover();
      const verdict = source.admit(item);
      expect(verdict.admitted).toBe(false);
      expect(verdict.reason).toContain('error');
    });

    it('skips an unreadable transcript instead of throwing', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const [item] = await source.discover();
      rmSync(item.path);
      // The Brain is auxiliary: a vanished file is a skip with a reason, never
      // an exception into whatever is draining the queue.
      expect(() => source.admit(item)).not.toThrow();
      expect(source.admit(item).admitted).toBe(false);
    });
  });

  describe('distill', () => {
    it('returns bounded prose and metadata for an item', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const [item] = await source.discover();
      const distilled = await source.distill!(item);
      expect(distilled.prose).toContain('USER: first ask');
      expect(distilled.prose).toContain('ASSISTANT: first answer');
      // The discriminant is asserted, not assumed: it is what tells the
      // extraction prompt this is a transcript rather than a capture.
      expect(distilled.metadata.kind).toBe('session');
      if (distilled.metadata.kind !== 'session') throw new Error('unreachable');
      expect(distilled.metadata.sessionId).toBe('sess-a');
      expect(distilled.metadata.promptCount).toBe(2);
    });

    it('rejects rather than inventing output when the transcript is gone', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const [item] = await source.discover();
      rmSync(item.path);
      // Unlike admit(), which degrades to a skip verdict, distill() has no
      // truthful empty answer: returning empty prose would let Plan 4 write a
      // note asserting the session had nothing in it.
      await expect(source.distill!(item)).rejects.toThrow(/cannot read/i);
    });
  });

  describe('BrainService source wiring', () => {
    // These live here rather than in brain-ipc.test.ts because that file
    // deliberately uses bare account ids with no `accounts` rows, and
    // discovery needs real config dirs on disk to walk.
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

      // The isolation property at the service boundary: listSources answers
      // for exactly the account asked about.
      expect(summaries.every((s) => s.accountId === personalId)).toBe(true);
      expect(summaries.map((s) => s.itemKey)).toEqual(['sess-personal']);
      expect(summaries[0]).toMatchObject({ admitted: true, status: null, changed: true });
      brain.closeAll();
    });

    it('will not preview another account item even when the key is known', async () => {
      writeSession(workCfg, '-Users-dev-Repos-mango', 'sess-work', GOOD);
      const brain = service();
      // A session id is unique per account, not globally. Matching on the key
      // alone would hand a work transcript to whoever asked as personal.
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

      createSourceStateStore(db).record(
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
      // Recorded at the same mtime, so nothing has moved since.
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

    /** Records which config dir each extraction ran under. */
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

    /**
     * Plan 8 §3. `brain_sources.cost_usd` already held the last run's figure,
     * but re-indexing overwrote it — so the vault could not say what it had
     * cost over any period, and the swept extraction transcripts meant nothing
     * else on the machine could either.
     */
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

      // Two runs is two payments. The snapshot column reports 0.01 either way,
      // which is exactly why the total cannot come from there.
      expect(createBrainSpendStore(db).total(personalId)).toBeCloseTo(0.02, 6);
    });

    it('writes no ledger row for an item that never reached the model', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = service(stubExtractor());

      // The stub extractor reports no `run`, which is how a translating source
      // and a gate rejection both look. A row here would invent a payment.
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

      // Not a resolved dir, not a default one. Indexing a work transcript
      // through the personal account would push work content through the
      // wrong subscription (spec §8).
      expect(calls).toEqual([personalCfg]);
      brain.closeAll();
    });

    it('refuses to index an item owned by another account', async () => {
      writeSession(workCfg, '-Users-dev-Repos-mango', 'sess-work', GOOD);
      const calls: string[] = [];
      const brain = service(stubExtractor(calls));

      await expect(brain.indexSource(personalId, 'sess-work')).rejects.toThrow(/not found/i);
      // No token spent on an item this account does not own.
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

      // The Brain is auxiliary: a failed extraction is a recorded status, not
      // an exception into whatever called this.
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

      // The property spec §9 names as the one to test hardest, asserted on the
      // bytes on disk rather than on the merge function's return value.
      expect(second).toBe(first);
      brain.closeAll();
    });

    it('indexes an empty extraction without writing a note', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = service(stubExtractor([], { entities: [] }));

      const result = await brain.indexSource(personalId, 'sess-a');

      // A session worth nothing is a valid, final answer — not a failure.
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

      // The whole point of the mtime-then-sha256 store. Without this check a
      // re-index spends a token to ask a NON-DETERMINISTIC model the same
      // question, and rewrites the note with whatever it says the second time
      // — which is how a stable vault turns into churn.
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

      // Deliberate re-index stays available — a better prompt or a better
      // model is exactly when you want to redo one.
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

      // A session the user continued is genuinely new material.
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
              // A second session names the same subsystem differently. Observed
              // live: this produced a SECOND note, because merge dedups by path.
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
      // Folded in, not replaced: both sessions are recorded as sources.
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

      // Over-matching would silently lose one entity inside another's note,
      // which is worse than the duplicate it was meant to prevent.
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

      // Resolution catches a mismatch after the fact; telling the model what
      // already exists stops it happening as often in the first place.
      expect(seen[0]).toEqual([]);
      expect(seen[1]).toContain('Brain memory vault');
      brain.closeAll();
    });

    it('isolates a bad entity: writes the others and records the failure', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const brain = service(async () => ({
        entities: [
          // `..` survives schema normalization (no separator) but vault.ts
          // rejects it. A model-supplied name is untrusted input for a path,
          // and one bad one must not cost the whole item.
          { type: 'Topic' as const, name: '..', aliases: [], keywords: [],
            summary: 'bad', links: [], decisions: [], keyFacts: [] },
          { type: 'Subsystem' as const, name: 'Good One', aliases: [], keywords: [],
            summary: 'fine', links: [], decisions: [], keyFacts: [] },
        ],
      }));

      const result = await brain.indexSource(personalId, 'sess-a');

      expect(result.notesWritten).toEqual(['Subsystems/Good One.md']);
      expect(result.reason).toMatch(/1 entit/i);
      // Partially-written is still indexed: the item was processed, and
      // re-running it would spend another token to reach the same place.
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
      // The Brain is auxiliary: even an extraction where every entity is
      // unusable resolves as a recorded outcome, never an exception.
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

      // Re-running backfill after a partial run must cost only what is left.
      // The revised time estimate assumes exactly this.
      await expect(brain.backfill(personalId)).resolves.toBe(0);
      brain.closeAll();
    });

    it('backfill only touches the account it was given', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-personal', GOOD);
      writeSession(workCfg, '-Users-dev-Repos-mango', 'sess-work', GOOD);
      const brain = service(stubExtractor());

      await brain.backfill(personalId);

      // Enqueuing a work transcript under the personal account would index it
      // through the wrong subscription (spec §4).
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

    /**
     * Plan 8: the global "a tab is open" gate is gone. What still holds is the
     * per-item guard — a transcript the user is actively writing to is skipped,
     * because distilling half a conversation and recording it as finished
     * would bake an incomplete note in permanently.
     */
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

      // The closed session is indexed even though another is open; the open
      // one is left alone.
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
      // A missing dependency must not become a silent no-op indexer.
      await expect(brain.indexSource(personalId, 'sess-a')).rejects.toThrow(/extractor/i);
      brain.closeAll();
    });
  });
});

/**
 * A session id is not unique per FILE. The CLI files transcripts per project
 * directory, so resuming a conversation in a different cwd — moving between a
 * git worktree and its main checkout, say — starts a second file carrying the
 * same session id.
 *
 * Observed in the field: session 91ca1859 ran in
 * `…/pi-tuitive--claude-worktrees-PI-272-289` until 2026-07-14T03:28:36 and
 * continued in `…/pi-tuitive` nine seconds later. Two files, 1,435 and 743
 * lines, one conversation.
 *
 * Emitting one item per file made those two rows collide on
 * `(account_id, source_id, item_key)`: React warned about the duplicate key,
 * both rows shared one state row, ticking one ticked both, and `findItem`
 * returned whichever came first — so indexing distilled half the conversation
 * and marked the whole thing done.
 */
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
    // Order is the conversation's order: the half that was written first is
    // the half that was said first.
    expect(item.paths).toEqual([older, newer]);
  });

  it('reports the newest file as its primary path, size as the whole session', async () => {
    write(WORKTREE, 'sess-split', GOOD, EARLIER);
    const newer = write(MAIN, 'sess-split', GOOD, LATER);

    const [item] = await source.discover();
    // Where the conversation currently lives, which is also the project it
    // should be grouped and excluded under.
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
    // Two accounts can hold the same session id, and joining them would put
    // one account's conversation into the other's vault.
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
    // One prompt each: neither half clears the 2-prompt gate, the conversation
    // does. Judging a half would reject a real session.
    write(WORKTREE, 'sess-split', [PROMPT('only ask here', 1), PROSE('answer one', 1)].join('\n'), EARLIER);
    write(MAIN, 'sess-split', [PROMPT('only ask there', 2), PROSE('answer two', 2)].join('\n'), LATER);

    const [item] = await source.discover();
    expect(source.admit(item).admitted).toBe(true);
  });
});

/**
 * Change detection has to cover every file behind an item. Hashing only the
 * primary path would mean a session whose EARLIER half changed — a repaired
 * transcript, a resumed conversation gaining rows — looked unchanged, so the
 * note stayed built from content that no longer exists.
 */
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
    store.record(before, { status: 'indexed' });
    expect(store.hasChanged(before)).toBe(false);

    // Change the OLDER half's content, and touch the newest file without
    // changing it — which is what a live session does to its own transcript.
    // The touch is what gets past the mtime fast path (unmoved mtime means
    // unmoved bytes, by design, for single-file items too); the hash is then
    // the only thing that can notice the older half moved. Hashing `item.path`
    // alone reports no change here, which is the bug this pins.
    writeFileSync(older, `${GOOD}\n${PROMPT('a third ask', 3)}`, 'utf-8');
    const keepOld = new Date(EARLIER);
    utimesSync(older, keepOld, keepOld);
    const touched = new Date(LATER + 60_000);
    utimesSync(newest, touched, touched);

    const [after] = await source.discover();
    // The newest file is still the primary — only its timestamp moved.
    expect(after.path).toBe(newest);
    expect(store.hasChanged(after)).toBe(true);
  });
});
