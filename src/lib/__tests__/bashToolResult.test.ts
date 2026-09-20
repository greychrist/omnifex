import { describe, it, expect } from 'vitest';
import {
  collectStructuredResults,
  parseGitOperation,
  parseBashEditDiff,
} from '@/lib/bashToolResult';

const userNode = (raw: Record<string, unknown>) => ({ kind: 'user' as const, raw });

const envelope = (toolIds: string[], extra: Record<string, unknown> = {}) => ({
  message: {
    role: 'user',
    content: toolIds.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })),
  },
  ...extra,
});

describe('collectStructuredResults — the two spellings', () => {
  // The live stream-json stdout and the on-disk JSONL carry the SAME payload
  // under different keys: `tool_use_result` live, `toolUseResult` on disk.
  // Verified against CLI 2.1.270. Both the stream and the file feed the
  // renderer, so a widget that reads one spelling works on exactly one path.
  it('reads tool_use_result, as the live stream spells it', () => {
    const got = collectStructuredResults([
      userNode(envelope(['t1'], { tool_use_result: { stdout: 'hello' } })),
    ]);
    expect(got.get('t1')).toEqual({ stdout: 'hello' });
  });

  it('reads toolUseResult, as the on-disk JSONL spells it', () => {
    const got = collectStructuredResults([
      userNode(envelope(['t1'], { toolUseResult: { stdout: 'hello' } })),
    ]);
    expect(got.get('t1')).toEqual({ stdout: 'hello' });
  });

  it('prefers the live spelling when an envelope somehow carries both', () => {
    const got = collectStructuredResults([
      userNode(envelope(['t1'], { tool_use_result: { stdout: 'live' }, toolUseResult: { stdout: 'disk' } })),
    ]);
    expect(got.get('t1')).toEqual({ stdout: 'live' });
  });

  // One envelope carries at most ONE structured result but may carry several
  // tool_result blocks. Attributing that single payload to every block would
  // put one command's diff on another command's row. No such envelope appears
  // in 874 sampled transcripts, which is a reason to be correct, not lucky.
  it('refuses to attribute one structured result to several tool_results', () => {
    const got = collectStructuredResults([
      userNode(envelope(['t1', 't2'], { tool_use_result: { stdout: 'whose?' } })),
    ]);
    expect(got.size).toBe(0);
  });

  it('ignores non-user nodes and envelopes with no structured result', () => {
    const got = collectStructuredResults([
      { kind: 'assistant', raw: envelope(['t1'], { tool_use_result: { stdout: 'x' } }) },
      userNode(envelope(['t2'])),
    ]);
    expect(got.size).toBe(0);
  });

  it('survives malformed envelopes without throwing', () => {
    expect(() =>
      collectStructuredResults([
        userNode({ message: null as unknown as Record<string, unknown> }),
        userNode({ message: { content: 'not-an-array' } }),
        { kind: 'user', raw: null as unknown as Record<string, unknown> },
      ]),
    ).not.toThrow();
  });
});

describe('parseGitOperation', () => {
  // The four kinds observed across 323 real occurrences on disk.
  it('reads a push', () => {
    expect(parseGitOperation({ gitOperation: { push: { branch: 'main' } } }))
      .toEqual({ kind: 'push', label: 'pushed', detail: 'main' });
  });

  it('reads a commit', () => {
    expect(parseGitOperation({ gitOperation: { commit: { sha: 'ce418f1', kind: 'committed' } } }))
      .toEqual({ kind: 'commit', label: 'committed', detail: 'ce418f1' });
  });

  it('reads a branch operation, using its action as the label', () => {
    expect(parseGitOperation({ gitOperation: { branch: { ref: 'origin/develop', action: 'rebased' } } }))
      .toEqual({ kind: 'branch', label: 'rebased', detail: 'origin/develop' });
  });

  it('reads a pull request, rendering its number', () => {
    expect(parseGitOperation({ gitOperation: { pr: { number: 10, action: 'closed' } } }))
      .toEqual({ kind: 'pr', label: 'closed', detail: '#10' });
  });

  it('returns null when there is no git operation', () => {
    expect(parseGitOperation({ stdout: 'hello' })).toBeNull();
    expect(parseGitOperation(undefined)).toBeNull();
    expect(parseGitOperation({ gitOperation: {} })).toBeNull();
  });
});

describe('parseBashEditDiff', () => {
  const hunk = (lines: string[]) => ({ lines });

  it('summarises per-file adds and removes', () => {
    const got = parseBashEditDiff({
      bashEditDiff: {
        files: [{ filePath: '/r/a.ts', hunks: [hunk([' ctx', '+added', '-removed', '+added2'])] }],
        moreFiles: 0,
      },
    });
    expect(got).toMatchObject({
      files: [{ filePath: '/r/a.ts', added: 2, removed: 1, created: false, deleted: false }],
      moreFiles: 0,
    });
  });

  it('carries created and deleted markers', () => {
    const got = parseBashEditDiff({
      bashEditDiff: {
        files: [
          { filePath: '/r/new.ts', hunks: [], created: true },
          { filePath: '/r/gone.ts', hunks: [], deleted: true },
        ],
        moreFiles: 0,
      },
    });
    expect(got?.files.map((f) => [f.created, f.deleted])).toEqual([[true, false], [false, true]]);
  });

  // `changedFiles` is the authoritative list — "every changed file known, shown
  // or not". It is what survives when the diff itself is unavailable.
  it('keeps changedFiles when the diff body is unavailable', () => {
    const got = parseBashEditDiff({
      bashEditDiff: { files: [], moreFiles: 3, changedFiles: ['/r/a', '/r/b'], unavailable: true },
    });
    expect(got).toMatchObject({ files: [], moreFiles: 3, changedFiles: ['/r/a', '/r/b'], unavailable: true });
  });

  // `shared` means another command touched the repo concurrently, so the
  // attribution is not trustworthy — the UI must say so rather than imply it.
  it('reports the shared-repository caveat', () => {
    const got = parseBashEditDiff({ bashEditDiff: { files: [], moreFiles: 1, shared: true } });
    expect(got?.shared).toBe(true);
  });

  // A skipped diff is the CLI saying "nothing to show here", which must not
  // render as an empty-but-present diff panel.
  it('returns null for a skipped diff and for absent data', () => {
    expect(parseBashEditDiff({ bashEditDiff: { files: [], moreFiles: 0, skipped: true } })).toBeNull();
    expect(parseBashEditDiff({ stdout: 'x' })).toBeNull();
    expect(parseBashEditDiff(undefined)).toBeNull();
  });

  // An entry with no files, no overflow and no caveat carries no information.
  it('returns null for an empty diff with nothing to say', () => {
    expect(parseBashEditDiff({ bashEditDiff: { files: [], moreFiles: 0 } })).toBeNull();
  });
});
