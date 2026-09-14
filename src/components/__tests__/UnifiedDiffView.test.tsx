// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { UnifiedDiffView } from '../shared/UnifiedDiffView';
import { parseUnifiedDiff } from '@/lib/unifiedDiff';

afterEach(() => { cleanup(); });

const DIFF = `diff --git a/src/lib/api.ts b/src/lib/api.ts
--- a/src/lib/api.ts
+++ b/src/lib/api.ts
@@ -10,3 +10,4 @@ export const api = {
   listAccounts: () => invoke('list_accounts'),
-  getVersion: () => invoke('get_version'),
+  getVersion: () => invoke('get_app_version'),
+  restartDaemon: () => invoke('remote:restart'),
`;

const view = (text: string, maxLines?: number) => {
  const diff = parseUnifiedDiff(text, maxLines === undefined ? {} : { maxLines })!;
  return render(<UnifiedDiffView diff={diff} />);
};

describe('UnifiedDiffView', () => {
  it('names the file and totals both sides', () => {
    view(DIFF);
    expect(screen.getByText('src/lib/api.ts')).toBeTruthy();
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
  });

  it('shows the hunk header, so a line number means something', () => {
    view(DIFF);
    expect(screen.getByText(/@@ -10,3 \+10,4 @@/)).toBeTruthy();
  });

  it('numbers both sides', () => {
    const { container } = view(DIFF);
    const gutters = [...container.querySelectorAll('[data-diff-line] .tabular-nums')].map((e) => e.textContent);
    // old / new per row: context 10/10, removal 11/–, additions –/11 and –/12.
    expect(gutters).toEqual(['10', '10', '11', '', '', '11', '', '12']);
  });

  // Colour is the third signal, never the only one: the sign column carries a
  // glyph so add/remove survives a screenshot or a colourblind reader.
  it('marks every changed line with a sign, not just a tint', () => {
    const { container } = view(DIFF);
    const signs = [...container.querySelectorAll('[data-diff-line] .w-4')].map((e) => e.textContent?.trim());
    expect(signs).toEqual(['', '-', '+', '+']);
  });

  it('tints the row rather than recolouring the code', () => {
    const { container } = view(DIFF);
    const added = container.querySelector('.bg-green-500\\/8');
    expect(added).toBeTruthy();
    // The code itself keeps the normal foreground — a diff is still code.
    expect(added?.querySelector('.text-foreground\\/90')).toBeTruthy();
    expect(container.querySelector('.bg-red-500\\/10')).toBeTruthy();
  });

  it('says what it left out instead of silently cutting the diff', () => {
    const body = Array.from({ length: 30 }, (_, i) => `+line ${String(i)}`).join('\n');
    view(`--- a/x\n+++ b/x\n@@ -0,0 +1,30 @@\n${body}\n`, 5);
    expect(screen.getByText(/25 more changed lines/)).toBeTruthy();
  });

  it('keeps whatever the command printed before the diff', () => {
    view(`Comparing working tree\n\n${DIFF}`);
    expect(screen.getByText(/Comparing working tree/)).toBeTruthy();
  });

  it('states a binary file instead of showing empty hunks', () => {
    view(`diff --git a/icon.png b/icon.png\nBinary files a/icon.png and b/icon.png differ\n`);
    expect(screen.getByText(/Binary file/)).toBeTruthy();
  });
});
