import { describe, it, expect } from 'vitest';
import { looksLikeUnifiedDiff, parseUnifiedDiff } from '../unifiedDiff';

const GIT_DIFF = `diff --git a/src/lib/api.ts b/src/lib/api.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/lib/api.ts
+++ b/src/lib/api.ts
@@ -10,7 +10,8 @@ export const api = {
   listAccounts: () => invoke('list_accounts'),
-  getVersion: () => invoke('get_version'),
+  getVersion: () => invoke('get_app_version'),
+  restartDaemon: () => invoke('remote:restart'),
   close: () => invoke('close'),
`;

describe('looksLikeUnifiedDiff', () => {
  it('recognises git diff output', () => {
    expect(looksLikeUnifiedDiff(GIT_DIFF)).toBe(true);
  });

  it('recognises a bare `diff -u` with no git header', () => {
    const text = '--- old.txt\n+++ new.txt\n@@ -1 +1 @@\n-a\n+b\n';
    expect(looksLikeUnifiedDiff(text)).toBe(true);
  });

  // The detector decides whether a Bash result is rendered as a diff instead
  // of as output. A false positive turns ordinary text into a broken diff, so
  // it demands a hunk header, not merely lines that start with + or -.
  it('is not fooled by output that merely contains + and - lines', () => {
    expect(looksLikeUnifiedDiff('+ installed foo@1.2.3\n- removed bar\n')).toBe(false);
    expect(looksLikeUnifiedDiff('--- a section heading ---\nsome text\n')).toBe(false);
    expect(looksLikeUnifiedDiff('')).toBe(false);
  });

  it('is not fooled by `git diff --stat`, which has no hunks', () => {
    expect(looksLikeUnifiedDiff(' src/lib/api.ts | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)\n')).toBe(false);
  });
});

describe('parseUnifiedDiff', () => {
  it('returns null for text that is not a diff', () => {
    expect(parseUnifiedDiff('npm test\n5688 passed\n')).toBeNull();
  });

  it('reads the path, the counts and the hunk', () => {
    const parsed = parseUnifiedDiff(GIT_DIFF)!;
    expect(parsed.files).toHaveLength(1);
    const file = parsed.files[0];
    expect(file.path).toBe('src/lib/api.ts');
    expect(file.added).toBe(2);
    expect(file.removed).toBe(1);
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0].header).toBe('@@ -10,7 +10,8 @@ export const api = {');
  });

  it('numbers both sides the way the hunk header says', () => {
    const lines = parseUnifiedDiff(GIT_DIFF)!.files[0].hunks[0].lines;
    expect(lines.map((l) => [l.kind, l.oldNumber, l.newNumber])).toEqual([
      ['ctx', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['ctx', 12, 13],
    ]);
  });

  it('keeps the line text without its +/- marker', () => {
    const lines = parseUnifiedDiff(GIT_DIFF)!.files[0].hunks[0].lines;
    expect(lines[1].text).toBe("  getVersion: () => invoke('get_version'),");
    expect(lines[2].text).toBe("  getVersion: () => invoke('get_app_version'),");
  });

  it('splits a multi-file diff', () => {
    const text = `${GIT_DIFF}diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-# Old
+# New
`;
    const parsed = parseUnifiedDiff(text)!;
    expect(parsed.files.map((f) => f.path)).toEqual(['src/lib/api.ts', 'README.md']);
  });

  it('marks a new file, a deleted file and a rename', () => {
    const text = `diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+hello
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old-name.ts b/new-name.ts
similarity index 98%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1 +1 @@
-a
+b
`;
    const files = parseUnifiedDiff(text)!.files;
    expect(files[0]).toMatchObject({ path: 'new.ts', created: true, deleted: false });
    expect(files[1]).toMatchObject({ path: 'gone.ts', created: false, deleted: true });
    expect(files[2]).toMatchObject({ path: 'new-name.ts', oldPath: 'old-name.ts', renamed: true });
  });

  it('reports a binary file rather than pretending it has hunks', () => {
    const text = `diff --git a/icon.png b/icon.png
index abc..def 100644
Binary files a/icon.png and b/icon.png differ
`;
    const file = parseUnifiedDiff(text)!.files[0];
    expect(file.binary).toBe(true);
    expect(file.hunks).toEqual([]);
  });

  it('keeps the no-newline marker out of the line count', () => {
    const text = `--- a/x
+++ b/x
@@ -1 +1 @@
-a
\\ No newline at end of file
+b
`;
    const file = parseUnifiedDiff(text)!.files[0];
    expect(file.added).toBe(1);
    expect(file.removed).toBe(1);
    expect(file.hunks[0].lines.map((l) => l.kind)).toEqual(['del', 'add']);
  });

  // Nothing may be silently dropped: a command that printed something before
  // its diff still printed it.
  it('keeps whatever was printed before the first file', () => {
    const parsed = parseUnifiedDiff(`Running git diff...\n\n${GIT_DIFF}`)!;
    expect(parsed.preamble).toEqual(['Running git diff...', '']);
  });

  it('stops at a line budget and says how many lines it left', () => {
    const body = Array.from({ length: 50 }, (_, i) => `+line ${String(i)}`).join('\n');
    const text = `--- a/x\n+++ b/x\n@@ -0,0 +1,50 @@\n${body}\n`;
    const parsed = parseUnifiedDiff(text, { maxLines: 10 })!;
    expect(parsed.files[0].hunks[0].lines).toHaveLength(10);
    expect(parsed.truncated).toBe(40);
    // The counts still describe the whole diff, not the part that fit.
    expect(parsed.files[0].added).toBe(50);
  });

  it('does not truncate a diff that fits', () => {
    expect(parseUnifiedDiff(GIT_DIFF, { maxLines: 500 })!.truncated).toBe(0);
  });
});
