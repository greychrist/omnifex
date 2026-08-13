import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AccountsService } from '../services/accounts';
import {
  createRepoArtifactSource,
  repoPathFromTranscripts,
} from '../services/brain/sources/repo-artifacts';

function writeTranscript(configDir: string, project: string, name: string, cwd: string | null) {
  const dir = join(configDir, 'projects', project);
  mkdirSync(dir, { recursive: true });
  const rows = [
    // A leading row with no cwd, which real transcripts have.
    JSON.stringify({ type: 'summary', summary: 'no cwd on this row' }),
    ...(cwd ? [JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } })] : []),
  ];
  writeFileSync(join(dir, `${name}.jsonl`), `${rows.join('\n')}\n`, 'utf8');
}

describe('repoPathFromTranscripts', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-repo-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the real path from a transcript rather than the directory name', () => {
    // The encoded name is LOSSY: this one decodes naively to
    // /Users/dev/Repos/wombeats/ios, which does not exist. The real repo is
    // /Users/dev/Repos/wombeats-ios, and only the transcript knows that.
    const project = '-Users-dev-Repos-wombeats-ios';
    writeTranscript(tmp, project, 'sess-a', '/Users/dev/Repos/wombeats-ios');

    expect(repoPathFromTranscripts(join(tmp, 'projects', project))).toBe(
      '/Users/dev/Repos/wombeats-ios',
    );
  });

  it('skips rows that carry no cwd', () => {
    writeTranscript(tmp, '-p', 'sess-a', '/Users/dev/repo');
    expect(repoPathFromTranscripts(join(tmp, 'projects', '-p'))).toBe('/Users/dev/repo');
  });

  it('returns null when no transcript carries a cwd', () => {
    writeTranscript(tmp, '-p', 'sess-a', null);
    expect(repoPathFromTranscripts(join(tmp, 'projects', '-p'))).toBeNull();
  });

  it('returns null for a directory with no transcripts', () => {
    mkdirSync(join(tmp, 'projects', '-empty'), { recursive: true });
    expect(repoPathFromTranscripts(join(tmp, 'projects', '-empty'))).toBeNull();
  });

  it('returns null for a directory that does not exist', () => {
    expect(repoPathFromTranscripts(join(tmp, 'projects', '-absent'))).toBeNull();
  });

  it('survives a truncated final line from the bounded read', () => {
    const dir = join(tmp, 'projects', '-p');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'sess.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: '/Users/dev/repo' })}\n{"type":"user","cwd":"/trun`,
      'utf8',
    );
    expect(repoPathFromTranscripts(dir)).toBe('/Users/dev/repo');
  });
});

describe('repo artifact source', () => {
  let tmp: string;
  let cfg: string;
  let repo: string;

  function accountsWith(resolved: number | null): AccountsService {
    return {
      listAccounts: () => [{ id: 1, config_dir: cfg }],
      resolve: () => ({
        claude: resolved === null ? null : { account: { id: resolved, config_dir: cfg } },
        codex: null,
      }),
    } as unknown as AccountsService;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-repoart-'));
    cfg = join(tmp, 'cfg');
    repo = join(tmp, 'repo');
    mkdirSync(repo, { recursive: true });
    writeTranscript(cfg, '-repo', 'sess-a', repo);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('discovers CLAUDE.md and AGENTS.md, root and nested', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n\nsome rules\n', 'utf8');
    writeFileSync(join(repo, 'AGENTS.md'), '# agents\n\nagent rules\n', 'utf8');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'CLAUDE.md'), '# src rules\n\nnested\n', 'utf8');

    const items = await createRepoArtifactSource({ accounts: accountsWith(1) }).discover();
    expect(items.map((i) => i.itemKey).sort()).toEqual([
      `${repo}:AGENTS.md`,
      `${repo}:CLAUDE.md`,
      `${repo}:src/CLAUDE.md`,
    ]);
  });

  /**
   * The label is the PROJECT, never the file. It is what the Sources pane
   * groups on and what exclusions key on, so labelling an artifact `CLAUDE.md`
   * both read as a file at the root of the drive and made every repo's
   * instruction file share one exclusion.
   */
  it('labels an artifact with its repo, not with the file', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n\nsome rules\n', 'utf8');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'CLAUDE.md'), '# src rules\n\nnested\n', 'utf8');

    const items = await createRepoArtifactSource({ accounts: accountsWith(1) }).discover();

    expect(items.map((i) => i.label)).toEqual([repo, repo]);
  });

  it('ignores README, CHANGELOG and docs', async () => {
    writeFileSync(join(repo, 'README.md'), '# readme\n', 'utf8');
    writeFileSync(join(repo, 'CHANGELOG.md'), '# changelog\n', 'utf8');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'design.md'), '# design\n', 'utf8');

    expect(await createRepoArtifactSource({ accounts: accountsWith(1) }).discover()).toEqual([]);
  });

  it('does not walk node_modules', async () => {
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'pkg', 'CLAUDE.md'), '# vendored\n', 'utf8');

    expect(await createRepoArtifactSource({ accounts: accountsWith(1) }).discover()).toEqual([]);
  });

  it('owns an artifact by resolve(), not by the config dir it was found through', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n\nsome rules\n', 'utf8');
    const items = await createRepoArtifactSource({ accounts: accountsWith(2) }).discover();
    expect(items[0].accountId).toBe(2);
  });

  it('omits an artifact whose repo resolves to no account', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n\nsome rules\n', 'utf8');
    // An adapter that cannot determine ownership omits the item rather than
    // guessing — guessing writes one account's material into another's vault.
    expect(await createRepoArtifactSource({ accounts: accountsWith(null) }).discover()).toEqual([]);
  });

  it('rejects an empty artifact', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), '   \n', 'utf8');
    const source = createRepoArtifactSource({ accounts: accountsWith(1) });
    const [item] = await source.discover();
    expect(source.admit(item).admitted).toBe(false);
  });

  it('distills the file with artifact metadata', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n\nuse npm, not yarn\n', 'utf8');
    const source = createRepoArtifactSource({ accounts: accountsWith(1) });
    const [item] = await source.discover();

    const distilled = await source.distill!(item);
    expect(distilled.prose).toContain('use npm, not yarn');
    expect(distilled.truncated).toBe(false);
    expect(distilled.metadata).toEqual({ kind: 'artifact', repoPath: repo, file: 'CLAUDE.md' });
  });

  it('keeps the repo path intact for a nested artifact', async () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'CLAUDE.md'), '# nested\n\nrules\n', 'utf8');
    const source = createRepoArtifactSource({ accounts: accountsWith(1) });
    const [item] = await source.discover();

    const distilled = await source.distill!(item);
    expect(distilled.metadata).toEqual({ kind: 'artifact', repoPath: repo, file: 'src/CLAUDE.md' });
  });

  it('truncates an oversized artifact and says so', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), `# rules\n\n${'x'.repeat(20_000)}\n`, 'utf8');
    const source = createRepoArtifactSource({ accounts: accountsWith(1) });
    const [item] = await source.discover();

    const distilled = await source.distill!(item);
    expect(distilled.truncated).toBe(true);
    expect(distilled.prose.length).toBeLessThan(20_000);
  });

  it('offers no translate — an artifact goes through the model', () => {
    expect(createRepoArtifactSource({ accounts: accountsWith(1) }).translate).toBeUndefined();
  });

  it('reports one repo once even when two accounts have run in it', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n\nsome rules\n', 'utf8');
    const twoAccounts = {
      listAccounts: () => [
        { id: 1, config_dir: cfg },
        { id: 2, config_dir: cfg },
      ],
      resolve: () => ({ claude: { account: { id: 1, config_dir: cfg } }, codex: null }),
    } as unknown as AccountsService;

    const items = await createRepoArtifactSource({ accounts: twoAccounts }).discover();
    expect(items).toHaveLength(1);
  });
});
