// @vitest-environment jsdom
//
// The Bash row renders two things the model never sees: the CLI's own
// classification of the git work a command did, and the diff of what it
// changed on disk. Both ride the STRUCTURED result on the envelope, not the
// tool_result content block the widget has always read — so these tests exist
// mainly to pin that the structured payload reaches the widget at all.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BashWidget } from '@/components/claude/tools/BashWidget';

afterEach(() => { cleanup(); });

describe('BashWidget — git operation chip', () => {
  it('renders a push with its branch', () => {
    render(
      <BashWidget
        command="git push origin main"
        structured={{ gitOperation: { push: { branch: 'main' } } }}
      />,
    );
    expect(screen.getByText('pushed')).toBeTruthy();
    expect(screen.getByText('main')).toBeTruthy();
  });

  it('renders a commit with its sha', () => {
    render(
      <BashWidget
        command="git commit -m x"
        structured={{ gitOperation: { commit: { sha: 'ce418f1', kind: 'committed' } } }}
      />,
    );
    expect(screen.getByText('committed')).toBeTruthy();
    expect(screen.getByText('ce418f1')).toBeTruthy();
  });

  // The overwhelmingly common case: a Bash command that touched no git state.
  it('renders no chip for an ordinary command', () => {
    render(<BashWidget command="echo hello" structured={{ stdout: 'hello' }} />);
    expect(screen.queryByText('pushed')).toBeNull();
  });

  // Chat mode before the result lands, and every pre-2.1.269 transcript.
  it('renders without a structured result at all', () => {
    expect(() => render(<BashWidget command="echo hello" />)).not.toThrow();
  });
});

describe('BashWidget — bash edit diff', () => {
  it('lists changed files with their add/remove counts', () => {
    render(
      <BashWidget
        command="sed -i '' s/a/b/ f.txt"
        structured={{
          bashEditDiff: {
            files: [{ filePath: '/r/f.txt', hunks: [{ lines: [' ctx', '+b', '-a'] }] }],
            moreFiles: 0,
          },
        }}
      />,
    );
    expect(screen.getByText('/r/f.txt')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
  });

  // The caveat matters more than the diff: if a concurrent command touched the
  // repo, these files may not be this command's work at all.
  it('surfaces the shared-repository caveat', () => {
    render(
      <BashWidget
        command="git status"
        structured={{ bashEditDiff: { files: [], moreFiles: 1, shared: true } }}
      />,
    );
    expect(screen.getByText(/Another command ran in this repository/)).toBeTruthy();
  });

  it('renders nothing for a skipped diff', () => {
    render(
      <BashWidget
        command="ls"
        structured={{ bashEditDiff: { files: [], moreFiles: 0, skipped: true } }}
      />,
    );
    expect(screen.queryByText(/Files this command changed/)).toBeNull();
  });
});
