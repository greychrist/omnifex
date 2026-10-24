import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cliReviewPrompt from '@/lib/cliReviewPrompt';
import { CLI_REVIEW_PROMPT, renderCliReviewPrompt } from '@/lib/cliReviewPrompt';

describe('no user override', () => {
  it('exports no settings key: the prompt is repaired in the repo, not edited in the app', () => {
    // A saved override was a full copy that froze the prompt at the version
    // saved — and "Reset to default" saved one. Removed 2026-10-24.
    expect('CLI_REVIEW_PROMPT_SETTING_KEY' in cliReviewPrompt).toBe(false);
    expect('DEFAULT_CLI_REVIEW_PROMPT' in cliReviewPrompt).toBe(false);
  });
});

describe('CLI_REVIEW_PROMPT', () => {
  it('carries both version placeholders', () => {
    // A default that lost a placeholder would silently review the wrong range.
    expect(CLI_REVIEW_PROMPT).toContain('{reviewedVersion}');
    expect(CLI_REVIEW_PROMPT).toContain('{installedVersion}');
  });

  it('uses no positional $1/$2 markers', () => {
    // The old .claude/commands/ file used $1/$2 and the harness substituted
    // them inconsistently — $1 came through as the *installed* version while
    // $2 was left literal, so the prompt described the wrong range.
    expect(CLI_REVIEW_PROMPT).not.toMatch(/\$[12]\b/);
  });

  it('still names the surfaces the review has to check', () => {
    expect(CLI_REVIEW_PROMPT).toContain('src/types/jsonl.ts');
    expect(CLI_REVIEW_PROMPT).toContain('permission-prompt-tool');
    expect(CLI_REVIEW_PROMPT).toContain('REVIEWED_CLI_VERSION');
  });

  // The changelog is not the whole surface. `atis-latch` shipped as a new
  // JSONL record type, never appeared in a changelog entry, and drew hundreds
  // of "Unrecognized record" cards before anyone noticed — because every step
  // of this prompt started from the changelog.
  it('asks for a binary diff, not just a changelog read', () => {
    expect(CLI_REVIEW_PROMPT).toContain('versions/');
    expect(CLI_REVIEW_PROMPT).toMatch(/merge-strategy map/i);
    expect(CLI_REVIEW_PROMPT).toContain('cliSidechannelRecords.ts');
  });

  it('is self-contained prose, not a slash-command invocation', () => {
    // The whole point of moving it into the app: it must not depend on a file
    // under .claude/, which is gitignored and ships with nobody.
    expect(CLI_REVIEW_PROMPT.trimStart()).not.toMatch(/^\//);
    expect(CLI_REVIEW_PROMPT.length).toBeGreaterThan(500);
  });
});

// The prompt is only as good as its pointers. It names files and the symbols
// inside them; a refactor that moves either leaves the reviewer chasing a path
// that is not there, and the review quietly gets thinner. These tests turn a
// stale pointer into a failing build instead.
describe('CLI_REVIEW_PROMPT pointers', () => {
  const REPO = path.resolve(__dirname, '../../..');
  const PATH_RE = /`((?:src|electron|docs|scripts|macos|packaging|omnifex-mod)\/[\w./-]+?)(?::\d+)?`/g;

  it('names only repo paths that exist', () => {
    const paths = [...CLI_REVIEW_PROMPT.matchAll(PATH_RE)].map((m) => m[1].replace(/\/$/, ''));
    expect(paths.length).toBeGreaterThan(15);
    const missing = paths.filter((p) => !fs.existsSync(path.join(REPO, p)));
    expect(missing).toEqual([]);
  });

  it('names only symbols that exist in the file it says they live in', () => {
    // Convention: `path/to/file.ts` (`symbolA`, `symbolB`)
    const pairs = [...CLI_REVIEW_PROMPT.matchAll(/`([\w./-]+\.(?:ts|tsx|md|mjs|swift))` \(([^)]*)\)/g)];
    expect(pairs.length).toBeGreaterThan(8);
    const missing: string[] = [];
    for (const [, file, list] of pairs) {
      const text = fs.readFileSync(path.join(REPO, file), 'utf8');
      for (const [, sym] of list.matchAll(/`([^`]+)`/g)) {
        if (!text.includes(sym)) missing.push(`${file}: ${sym}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('points at the binary-diff script it relies on', () => {
    expect(CLI_REVIEW_PROMPT).toContain('npm run cli-review:diff');
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    expect(pkg.scripts['cli-review:diff']).toContain('scripts/cli-review-diff.ts');
  });

  it('tells the reviewer to repair the prompt and script when they rot', () => {
    expect(CLI_REVIEW_PROMPT).toContain('src/lib/cliReviewPrompt.ts');
    expect(CLI_REVIEW_PROMPT).toMatch(/ANCHOR NOT FOUND/);
  });
});

describe('renderCliReviewPrompt', () => {
  it('fills both versions everywhere and leaves no placeholder behind', () => {
    const out = renderCliReviewPrompt('2.1.222', '2.1.224');
    expect(out).not.toContain('{reviewedVersion}');
    expect(out).not.toContain('{installedVersion}');
    expect(out.split('2.1.222').length).toBe(CLI_REVIEW_PROMPT.split('{reviewedVersion}').length);
    expect(out.split('2.1.224').length).toBe(CLI_REVIEW_PROMPT.split('{installedVersion}').length);
  });

  it('does not let a version string containing $& corrupt the output', () => {
    // String.replace treats $& in the *replacement* as a backreference.
    expect(renderCliReviewPrompt('a', '$&x')).toContain('$&x');
  });
});
