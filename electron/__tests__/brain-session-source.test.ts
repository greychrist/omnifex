import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService, type AccountsService } from '../services/accounts';
import { createBrainService } from '../services/brain/registry';
import { createSessionSource } from '../services/brain/sources/session-transcripts';
import { createSourceStateStore } from '../services/brain/sources/state';
import type { BrainSource, DistilledItem } from '../services/brain/sources/types';
import type { Extractor } from '../services/brain/extract';

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

    it('labels an item with its project directory for the Sources pane', async () => {
      writeSession(personalCfg, '-Users-dev-Repos-omnifex', 'sess-a', GOOD);
      const [item] = await source.discover();
      expect(item.label).toBe('-Users-dev-Repos-omnifex');
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
      const distilled = await source.distill(item);
      expect(distilled.prose).toContain('USER: first ask');
      expect(distilled.prose).toContain('ASSISTANT: first answer');
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
      await expect(source.distill(item)).rejects.toThrow(/cannot read/i);
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
      expect(preview?.metadata.projectPath).toBe('/Users/dev/Repos/omnifex');
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
