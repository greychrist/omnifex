import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLI_REVIEW_PROMPT,
  CLI_REVIEW_PROMPT_SETTING_KEY,
  renderCliReviewPrompt,
} from '@/lib/cliReviewPrompt';

describe('CLI_REVIEW_PROMPT_SETTING_KEY', () => {
  it('is namespaced so it cannot collide with other app_settings keys', () => {
    expect(CLI_REVIEW_PROMPT_SETTING_KEY).toBe('cliReview.promptTemplate');
  });
});

describe('DEFAULT_CLI_REVIEW_PROMPT', () => {
  it('carries both version placeholders', () => {
    // A default that lost a placeholder would silently review the wrong range.
    expect(DEFAULT_CLI_REVIEW_PROMPT).toContain('{reviewedVersion}');
    expect(DEFAULT_CLI_REVIEW_PROMPT).toContain('{installedVersion}');
  });

  it('uses no positional $1/$2 markers', () => {
    // The old .claude/commands/ file used $1/$2 and the harness substituted
    // them inconsistently — $1 came through as the *installed* version while
    // $2 was left literal, so the prompt described the wrong range.
    expect(DEFAULT_CLI_REVIEW_PROMPT).not.toMatch(/\$[12]\b/);
  });

  it('still names the surfaces the review has to check', () => {
    expect(DEFAULT_CLI_REVIEW_PROMPT).toContain('src/types/jsonl.ts');
    expect(DEFAULT_CLI_REVIEW_PROMPT).toContain('permission-prompt-tool');
    expect(DEFAULT_CLI_REVIEW_PROMPT).toContain('REVIEWED_CLI_VERSION');
  });

  it('is self-contained prose, not a slash-command invocation', () => {
    // The whole point of moving it into the app: it must not depend on a file
    // under .claude/, which is gitignored and ships with nobody.
    expect(DEFAULT_CLI_REVIEW_PROMPT.trimStart()).not.toMatch(/^\//);
    expect(DEFAULT_CLI_REVIEW_PROMPT.length).toBeGreaterThan(500);
  });
});

describe('renderCliReviewPrompt', () => {
  it('substitutes both versions', () => {
    const out = renderCliReviewPrompt(
      'from {reviewedVersion} to {installedVersion}',
      '2.1.222',
      '2.1.224',
    );
    expect(out).toBe('from 2.1.222 to 2.1.224');
  });

  it('substitutes every occurrence, not just the first', () => {
    const out = renderCliReviewPrompt(
      '{reviewedVersion} {installedVersion} {reviewedVersion} {installedVersion}',
      'A',
      'B',
    );
    expect(out).toBe('A B A B');
  });

  it('falls back to the shipped default when the template is empty', () => {
    for (const empty of ['', '   ', null, undefined]) {
      const out = renderCliReviewPrompt(empty, '2.1.222', '2.1.224');
      expect(out).toContain('2.1.222');
      expect(out).toContain('2.1.224');
      expect(out).not.toContain('{reviewedVersion}');
    }
  });

  it('leaves a customized template otherwise untouched', () => {
    const out = renderCliReviewPrompt('just check {installedVersion} please', 'x', '9.9.9');
    expect(out).toBe('just check 9.9.9 please');
  });

  it('does not let a version string containing $& corrupt the output', () => {
    // String.replace treats $& in the *replacement* as a backreference; a
    // version that ever contained one would smear the match across the prompt.
    const out = renderCliReviewPrompt('[{installedVersion}]', 'a', '$&x');
    expect(out).toBe('[$&x]');
  });

  it('renders the shipped default with no placeholders left behind', () => {
    const out = renderCliReviewPrompt(DEFAULT_CLI_REVIEW_PROMPT, '2.1.222', '2.1.224');
    expect(out).not.toContain('{reviewedVersion}');
    expect(out).not.toContain('{installedVersion}');
    expect(out).toContain('2.1.222');
    expect(out).toContain('2.1.224');
  });
});
