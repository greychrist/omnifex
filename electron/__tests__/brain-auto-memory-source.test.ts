import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AccountsService } from '../services/accounts';
import {
  createAutoMemorySource,
  parseAutoMemory,
  translateAutoMemory,
} from '../services/brain/sources/auto-memory';

/**
 * A redacted copy of a real auto-memory file. The format being already what it
 * is is the entire premise of this adapter, so the fixture is not invented.
 */
const REAL = `---
name: project_nodepty_pty_leak
description: Why node-pty is pinned to 1.2.0-beta.13 — fixes a pty leak
metadata:
  node_type: memory
  type: project
  originSessionId: ff79cd97-3318-4405-abbb-d20398bfc778
---

node-pty is pinned to **1.2.0-beta.13** (exact, not \`^\`).

**Why:** stable 1.1.0 leaks a pty master fd per spawn.

Related: [[project_native_module_abi.md]], [[feedback_electron_rebuild_after_tests.md]]
`;

function writeMemory(configDir: string, project: string, file: string, contents: string) {
  const dir = join(configDir, 'projects', project, 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), contents, 'utf8');
}

describe('parseAutoMemory', () => {
  it('reads name, description, type and body', () => {
    const parsed = parseAutoMemory(REAL, 'fallback');
    expect(parsed).toMatchObject({
      name: 'project_nodepty_pty_leak',
      description: 'Why node-pty is pinned to 1.2.0-beta.13 — fixes a pty leak',
      memoryType: 'project',
    });
    expect(parsed?.body).toContain('**Why:**');
  });

  it('falls back to the filename stem when name is missing', () => {
    expect(parseAutoMemory('---\ndescription: d\n---\n\nbody\n', 'some_file')?.name)
      .toBe('some_file');
  });

  it('returns null for a file with no frontmatter fence', () => {
    expect(parseAutoMemory('just prose\n', 'x')).toBeNull();
  });

  it('returns null for malformed YAML', () => {
    expect(parseAutoMemory('---\nname: [unclosed\n---\nbody\n', 'x')).toBeNull();
  });

  it('returns null for an empty body', () => {
    expect(parseAutoMemory('---\nname: n\n---\n\n   \n', 'x')).toBeNull();
  });

  it('tolerates a missing metadata block', () => {
    expect(parseAutoMemory('---\nname: n\n---\n\nbody\n', 'x')?.memoryType).toBe('');
  });
});

describe('translateAutoMemory', () => {
  const opts = {
    stem: 'project_nodepty_pty_leak',
    sourceKey: 'auto-memory:-Users-dev-repo/project_nodepty_pty_leak.md',
    date: '2026-08-12',
  };
  const translated = translateAutoMemory(parseAutoMemory(REAL, 'x')!, opts);

  it('names the note after the source FILE so existing wikilinks still bind', () => {
    // Memories link each other as [[project_native_module_abi.md]] and
    // linkMatchesNote binds by final segment with .md stripped. Measured on the
    // real corpus, 72 of 90 files have a `name:` that differs from the
    // filename, so naming notes after `name` would break four fifths of them.
    expect(translated.relPath).toBe('Notes/project_nodepty_pty_leak.md');
  });

  it('never lets a name become part of the path', () => {
    // Real values include "AWS cost reduction target ~$400/mo" — using one as a
    // path created nested directories inside Notes/. Plan 4a's lesson at a
    // different boundary: a name that came from outside is never a path.
    const nasty = parseAutoMemory(
      '---\nname: Don\'t grandfather tech debt via baselines/ratchets\n---\n\nbody\n',
      'feedback_no_tech_debt_baselining',
    )!;
    const out = translateAutoMemory(nasty, { ...opts, stem: 'feedback_no_tech_debt_baselining' });

    expect(out.relPath).toBe('Notes/feedback_no_tech_debt_baselining.md');
    expect(out.relPath.split('/')).toHaveLength(2);
    // Not lost, just not a path: it stays searchable as an alias.
    expect(out.note.frontmatter.aliases).toContain(
      "Don't grandfather tech debt via baselines/ratchets",
    );
  });

  it('maps description to a Summary section and keeps the body verbatim', () => {
    expect(translated.note.body).toContain('## Summary');
    expect(translated.note.body).toContain('Why node-pty is pinned');
    expect(translated.note.body).toContain('**Why:** stable 1.1.0 leaks');
    expect(translated.note.body).toContain('[[project_native_module_abi.md]]');
  });

  it('records the memory type as an alias and the note type as Note', () => {
    // `feedback` and `reference` have no NOTE_TYPES equivalent, and inventing
    // one would fork the ontology for four values.
    expect(translated.note.frontmatter.type).toBe('Note');
    // The name here equals the stem, so only the type is aliased.
    expect(translated.note.frontmatter.aliases).toEqual(['project']);
  });

  it('keeps a human name as an alias when it differs from the filename', () => {
    const humanNamed = parseAutoMemory(
      '---\nname: AWS cost reduction target\nmetadata:\n  type: project\n---\n\nbody\n',
      'project_aws_cost_reduction_target',
    )!;
    const out = translateAutoMemory(humanNamed, {
      ...opts,
      stem: 'project_aws_cost_reduction_target',
    });
    expect(out.note.frontmatter.aliases).toEqual(['AWS cost reduction target', 'project']);
  });

  it('never puts the origin session in sources', () => {
    // merge() dedups by source key: a Note claiming session:ff79cd97 would make
    // a later index of that transcript believe it was already covered, and the
    // session's own note would never be written.
    expect(translated.note.frontmatter.sources).toEqual([opts.sourceKey]);
    expect(JSON.stringify(translated.note.frontmatter)).not.toContain('ff79cd97');
  });

  it('is byte-identical on a second translation', () => {
    // No model is involved, so idempotency is provable on real output rather
    // than against a stub that would make the assertion vacuous.
    expect(translateAutoMemory(parseAutoMemory(REAL, 'x')!, opts)).toEqual(translated);
  });

  it('still produces a Summary when the memory has no description', () => {
    const bare = translateAutoMemory(
      parseAutoMemory('---\nname: x\n---\n\nbody\n', 'x')!,
      { ...opts, stem: 'x' },
    );
    expect(bare.note.body).toContain('## Summary');
    expect(bare.note.frontmatter.aliases).toEqual([]);
  });
});

describe('auto-memory source', () => {
  let tmp: string;
  let personal: string;
  let work: string;
  let source: ReturnType<typeof createAutoMemorySource>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-automem-'));
    personal = join(tmp, 'cfg-personal');
    work = join(tmp, 'cfg-work');
    const accounts = {
      listAccounts: () => [
        { id: 1, config_dir: personal },
        { id: 2, config_dir: work },
      ],
    } as unknown as AccountsService;
    source = createAutoMemorySource({ accounts });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('owns a file by the config dir it lives under', async () => {
    writeMemory(personal, '-repo-a', 'a.md', REAL);
    writeMemory(work, '-repo-b', 'b.md', REAL);

    const items = await source.discover();
    expect(items.map((i) => [i.accountId, i.itemKey]).sort()).toEqual([
      [1, '-repo-a/a.md'],
      [2, '-repo-b/b.md'],
    ]);
  });

  it("never attributes one account's memory to the other", async () => {
    writeMemory(work, '-repo-b', 'secret.md', REAL);
    const items = await source.discover();
    expect(items).toHaveLength(1);
    expect(items[0].accountId).toBe(2);
  });

  it('skips MEMORY.md, which is an index of its siblings', async () => {
    writeMemory(personal, '-repo-a', 'MEMORY.md', '- [A](a.md) — hook\n');
    writeMemory(personal, '-repo-a', 'a.md', REAL);

    expect((await source.discover()).map((i) => i.itemKey)).toEqual(['-repo-a/a.md']);
  });

  /**
   * Same rule as transcripts: the label stays the encoded dir (it is the key
   * exclusions hang off), and the path beside it is recovered from a real
   * `cwd` rather than decoded from that name.
   */
  it('carries the real folder path, recovered from a sibling transcript', async () => {
    writeMemory(personal, '-Users-dev-Repos-wombeats-ios', 'a.md', REAL);
    writeFileSync(
      join(personal, 'projects', '-Users-dev-Repos-wombeats-ios', 's.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/Users/dev/Repos/wombeats-ios' }),
      'utf8',
    );

    const [item] = await source.discover();

    expect(item.labelPath).toBe('/Users/dev/Repos/wombeats-ios');
  });

  it('qualifies the key by project, since slugs recur across projects', async () => {
    writeMemory(personal, '-repo-a', 'user_setup.md', REAL);
    writeMemory(personal, '-repo-b', 'user_setup.md', REAL);

    expect((await source.discover()).map((i) => i.itemKey).sort()).toEqual([
      '-repo-a/user_setup.md',
      '-repo-b/user_setup.md',
    ]);
  });

  it('admits a well-formed memory and rejects a broken one', async () => {
    writeMemory(personal, '-repo-a', 'good.md', REAL);
    writeMemory(personal, '-repo-a', 'bad.md', 'no frontmatter here\n');

    const items = await source.discover();
    const verdicts = Object.fromEntries(items.map((i) => [i.itemKey, source.admit(i)]));
    expect(verdicts['-repo-a/good.md'].admitted).toBe(true);
    expect(verdicts['-repo-a/bad.md'].admitted).toBe(false);
    expect(verdicts['-repo-a/bad.md'].reason).toMatch(/frontmatter|unreadable/i);
  });

  it('translates into Notes/ with the source key of its own file', async () => {
    writeMemory(personal, '-repo-a', 'project_nodepty_pty_leak.md', REAL);
    const [item] = await source.discover();

    const notes = await source.translate!(item);
    expect(notes).toHaveLength(1);
    expect(notes[0].relPath).toBe('Notes/project_nodepty_pty_leak.md');
    expect(notes[0].note.frontmatter.sources).toEqual([
      'auto-memory:-repo-a/project_nodepty_pty_leak.md',
    ]);
  });

  it('offers no distill — it must never reach the extractor', () => {
    expect(source.distill).toBeUndefined();
  });

  it('reports nothing when no account has a memory directory', async () => {
    expect(await source.discover()).toEqual([]);
  });

  it('ignores non-markdown files in a memory directory', async () => {
    writeMemory(personal, '-repo-a', 'notes.txt', 'ignore me');
    expect(await source.discover()).toEqual([]);
  });
});
