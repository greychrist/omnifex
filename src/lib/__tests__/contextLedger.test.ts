import { describe, it, expect } from 'vitest';
import { foldContextLedger, summariseContextAttachment } from '../contextLedger';
import type { JsonlNode } from '@/types/jsonl';

/**
 * Fixtures are shaped from REAL transcript records (both config dirs,
 * 2026-09-18 census), not invented. The field names are the load-bearing
 * part: `addedNames`/`removedNames`/`readdedNames` differ per delta type and
 * getting one wrong yields a plausible-looking wrong ledger.
 */
function att(type: string, body: Record<string, unknown>, at: string): JsonlNode {
  return {
    kind: 'attachment',
    raw: { type: 'attachment', attachment: { type, ...body } },
    sessionId: 's1',
    receivedAt: at,
  } as unknown as JsonlNode;
}

const T1 = '2026-09-18T10:00:00.000Z';
const T2 = '2026-09-18T10:01:00.000Z';
const T3 = '2026-09-18T10:02:00.000Z';

describe('foldContextLedger', () => {
  describe('tracked', () => {
    it('is false when no in-scope record ever arrived', () => {
      const ledger = foldContextLedger([
        att('total_tokens_reminder', { content: 'x' }, T1),
      ]);
      expect(ledger.tracked).toBe(false);
      expect(ledger.entries).toEqual([]);
    });

    it('is true once any in-scope record arrives', () => {
      const ledger = foldContextLedger([
        att('instructions', { files: [{ path: '/p/CLAUDE.md', type: 'Project', content: '# hi' }] }, T1),
      ]);
      expect(ledger.tracked).toBe(true);
    });
  });

  describe('snapshot rule — instructions', () => {
    it('records each file as a live entry with scope and content', () => {
      const ledger = foldContextLedger([
        att('instructions', {
          files: [
            { path: '/u/.claude/CLAUDE.md', type: 'User', content: 'user rules' },
            { path: '/p/CLAUDE.md', type: 'Project', content: 'project rules' },
          ],
        }, T1),
      ]);

      expect(ledger.entries).toHaveLength(2);
      expect(ledger.entries[0]).toMatchObject({
        kind: 'instruction-file',
        label: '/u/.claude/CLAUDE.md',
        scope: 'User',
        content: 'user rules',
        at: T1,
        live: true,
      });
      expect(ledger.liveCount).toBe(2);
    });

    it('supersedes a file dropped from a later snapshot, keeping it in the timeline', () => {
      const ledger = foldContextLedger([
        att('instructions', {
          files: [
            { path: '/p/CLAUDE.md', type: 'Project', content: 'a' },
            { path: '/p/CLAUDE.local.md', type: 'Local', content: 'b' },
          ],
        }, T1),
        att('instructions', {
          files: [{ path: '/p/CLAUDE.md', type: 'Project', content: 'a' }],
        }, T2),
      ]);

      const local = ledger.entries.find(e => e.label === '/p/CLAUDE.local.md');
      expect(local).toMatchObject({ live: false, endedAt: T2 });

      // The surviving file is not duplicated by the second snapshot.
      expect(ledger.entries.filter(e => e.label === '/p/CLAUDE.md')).toHaveLength(1);
      expect(ledger.liveCount).toBe(1);
    });

    it('carries a file the CLI names anything — AGENTS.md is not special-cased', () => {
      const ledger = foldContextLedger([
        att('instructions', {
          files: [{ path: '/p/AGENTS.md', type: 'Project', content: 'agents' }],
        }, T1),
      ]);
      expect(ledger.entries[0]).toMatchObject({ label: '/p/AGENTS.md', live: true });
    });
  });

  describe('additive rule — nested_memory', () => {
    it('reads path and scope from the nested content object', () => {
      const ledger = foldContextLedger([
        att('nested_memory', {
          path: '/p/src/CLAUDE.md',
          content: { path: '/p/src/CLAUDE.md', type: 'Project', content: 'renderer rules' },
        }, T1),
      ]);

      expect(ledger.entries[0]).toMatchObject({
        kind: 'nested-memory',
        label: '/p/src/CLAUDE.md',
        scope: 'Project',
        content: 'renderer rules',
        live: true,
      });
    });

    it('does not duplicate when the same path arrives twice', () => {
      const rec = att('nested_memory', {
        path: '/p/src/CLAUDE.md',
        content: { path: '/p/src/CLAUDE.md', type: 'Project', content: 'x' },
      }, T1);
      const ledger = foldContextLedger([rec, rec]);
      expect(ledger.entries).toHaveLength(1);
    });
  });

  describe('delta rule — mcp_instructions_delta', () => {
    it('adds a server and attaches its instruction block', () => {
      const ledger = foldContextLedger([
        att('mcp_instructions_delta', {
          addedNames: ['context7', 'omnifex-brain'],
          addedBlocks: ['## context7\nuse it', '## omnifex-brain\nvault'],
        }, T1),
      ]);

      expect(ledger.entries).toHaveLength(2);
      expect(ledger.entries[0]).toMatchObject({
        kind: 'mcp-server',
        label: 'context7',
        content: '## context7\nuse it',
        live: true,
      });
    });

    it('marks a removed server not-live but keeps it in the timeline', () => {
      const ledger = foldContextLedger([
        att('mcp_instructions_delta', { addedNames: ['ctx'], addedBlocks: ['b'] }, T1),
        att('mcp_instructions_delta', { removedNames: ['ctx'] }, T2),
      ]);

      expect(ledger.entries).toHaveLength(1);
      expect(ledger.entries[0]).toMatchObject({ label: 'ctx', live: false, endedAt: T2 });
      expect(ledger.liveCount).toBe(0);
    });

    it('records a re-add as a second timeline event, live again', () => {
      const ledger = foldContextLedger([
        att('mcp_instructions_delta', { addedNames: ['ctx'], addedBlocks: ['b'] }, T1),
        att('mcp_instructions_delta', { removedNames: ['ctx'] }, T2),
        att('mcp_instructions_delta', { addedNames: ['ctx'], addedBlocks: ['b2'] }, T3),
      ]);

      const ctx = ledger.entries.filter(e => e.label === 'ctx');
      expect(ctx).toHaveLength(2);
      expect(ctx[0]).toMatchObject({ at: T1, live: false, endedAt: T2 });
      expect(ctx[1]).toMatchObject({ at: T3, live: true });
      expect(ledger.liveCount).toBe(1);
    });

    it('tolerates a delta with neither added nor removed names', () => {
      const ledger = foldContextLedger([att('mcp_instructions_delta', {}, T1)]);
      expect(ledger.entries).toEqual([]);
    });
  });

  describe('delta rule — agent_listing_delta uses addedTypes/removedTypes', () => {
    it('folds agents by type name', () => {
      const ledger = foldContextLedger([
        att('agent_listing_delta', { addedTypes: ['Explore', 'Plan'] }, T1),
        att('agent_listing_delta', { removedTypes: ['Plan'] }, T2),
      ]);

      expect(ledger.entries.map(e => [e.label, e.live])).toEqual([
        ['Explore', true],
        ['Plan', false],
      ]);
      expect(ledger.entries.every(e => e.kind === 'agent')).toBe(true);
    });
  });

  describe('delta rule — deferred_tools_delta honours readdedNames', () => {
    it('treats readdedNames as an add', () => {
      const ledger = foldContextLedger([
        att('deferred_tools_delta', { addedNames: ['WebFetch'] }, T1),
        att('deferred_tools_delta', { removedNames: ['WebFetch'] }, T2),
        att('deferred_tools_delta', { readdedNames: ['WebFetch'] }, T3),
      ]);

      const hits = ledger.entries.filter(e => e.label === 'WebFetch');
      expect(hits).toHaveLength(2);
      expect(hits[1]).toMatchObject({ at: T3, live: true, kind: 'deferred-tool' });
    });
  });

  describe('snapshot rule — skill_listing', () => {
    it('keeps only the newest listing live', () => {
      const ledger = foldContextLedger([
        att('skill_listing', { content: 'v1' }, T1),
        att('skill_listing', { content: 'v2' }, T2),
      ]);

      expect(ledger.entries).toHaveLength(2);
      expect(ledger.entries[0]).toMatchObject({ content: 'v1', live: false, endedAt: T2 });
      expect(ledger.entries[1]).toMatchObject({ content: 'v2', live: true });
    });
  });

  describe('ordering and purity', () => {
    it('returns entries in arrival order across kinds', () => {
      const ledger = foldContextLedger([
        att('instructions', { files: [{ path: '/p/CLAUDE.md', type: 'Project', content: 'a' }] }, T1),
        att('mcp_instructions_delta', { addedNames: ['ctx'], addedBlocks: ['b'] }, T2),
        att('nested_memory', { path: '/p/s/CLAUDE.md', content: { path: '/p/s/CLAUDE.md', type: 'Project', content: 'c' } }, T3),
      ]);

      expect(ledger.entries.map(e => e.kind)).toEqual([
        'instruction-file', 'mcp-server', 'nested-memory',
      ]);
    });

    it('is idempotent — folding the same records twice is deep-equal', () => {
      const records = [
        att('instructions', { files: [{ path: '/p/CLAUDE.md', type: 'Project', content: 'a' }] }, T1),
        att('mcp_instructions_delta', { addedNames: ['ctx'], addedBlocks: ['b'] }, T2),
        att('mcp_instructions_delta', { removedNames: ['ctx'] }, T3),
      ];
      expect(foldContextLedger(records)).toEqual(foldContextLedger(records));
    });

    it('does not mutate its input', () => {
      const records = [
        att('instructions', { files: [{ path: '/p/CLAUDE.md', type: 'Project', content: 'a' }] }, T1),
      ];
      const before = JSON.stringify(records);
      foldContextLedger(records);
      expect(JSON.stringify(records)).toBe(before);
    });

    it('ignores non-attachment nodes entirely', () => {
      const ledger = foldContextLedger([
        { kind: 'assistant', raw: {}, sessionId: 's1', receivedAt: T1 } as unknown as JsonlNode,
        att('instructions', { files: [{ path: '/p/CLAUDE.md', type: 'Project', content: 'a' }] }, T1),
      ]);
      expect(ledger.entries).toHaveLength(1);
    });
  });

  describe('malformed records degrade rather than throw', () => {
    it('skips an instructions record whose files is not an array', () => {
      const ledger = foldContextLedger([att('instructions', { files: 'nope' }, T1)]);
      expect(ledger.entries).toEqual([]);
    });

    it('skips a file entry with no path', () => {
      const ledger = foldContextLedger([
        att('instructions', { files: [{ type: 'Project', content: 'a' }] }, T1),
      ]);
      expect(ledger.entries).toEqual([]);
    });

    // The scope list was an allow-list of User/Project/Local/Managed until
    // real transcripts turned up `AutoMem` (93 on disk) — the auto-memory
    // MEMORY.md — which the allow-list silently dropped. The CLI can add a
    // scope any release, so pass it through and let the UI style what it
    // knows. Dropping loses information; showing an unfamiliar badge does not.
    it('passes AutoMem through', () => {
      const ledger = foldContextLedger([
        att('instructions', { files: [{ path: '/u/MEMORY.md', type: 'AutoMem', content: 'a' }] }, T1),
      ]);
      expect(ledger.entries[0]).toMatchObject({ scope: 'AutoMem', live: true });
    });

    it('passes an unfamiliar scope through rather than dropping it', () => {
      const ledger = foldContextLedger([
        att('instructions', { files: [{ path: '/p/CLAUDE.md', type: 'SomeNewScope', content: 'a' }] }, T1),
      ]);
      expect(ledger.entries[0]).toMatchObject({ scope: 'SomeNewScope' });
    });

    it('leaves scope undefined when the record carries none', () => {
      const ledger = foldContextLedger([
        att('instructions', { files: [{ path: '/p/CLAUDE.md', content: 'a' }] }, T1),
      ]);
      expect(ledger.entries[0].scope).toBeUndefined();
    });
  });
});

describe('summariseContextAttachment', () => {
  const sum = (type: string, body: Record<string, unknown>) =>
    summariseContextAttachment({ type, ...body });

  it('returns null for out-of-scope bookkeeping', () => {
    expect(sum('total_tokens_reminder', { content: 'x' })).toBeNull();
    expect(sum('task_reminder', {})).toBeNull();
  });

  it('counts the instruction files loaded', () => {
    expect(sum('instructions', {
      files: [{ path: '/a/CLAUDE.md' }, { path: '/b/AGENTS.md' }],
    })).toBe('Instructions loaded — 2 files');
  });

  it('uses the singular for one file', () => {
    expect(sum('instructions', { files: [{ path: '/a/CLAUDE.md' }] }))
      .toBe('Instructions loaded — 1 file');
  });

  it('names the nested memory file', () => {
    expect(sum('nested_memory', { path: '/p/src/CLAUDE.md' }))
      .toBe('Nested memory — src/CLAUDE.md');
  });

  it('reports MCP additions and removals together', () => {
    expect(sum('mcp_instructions_delta', { addedNames: ['a', 'b'], removedNames: ['c'] }))
      .toBe('MCP servers +2 −1');
  });

  it('omits a zero side of a delta', () => {
    expect(sum('mcp_instructions_delta', { addedNames: ['a'] })).toBe('MCP servers +1');
    expect(sum('mcp_instructions_delta', { removedNames: ['c'] })).toBe('MCP servers −1');
  });

  it('returns null for a delta that changed nothing', () => {
    expect(sum('mcp_instructions_delta', {})).toBeNull();
  });

  it('counts readded tools as additions', () => {
    expect(sum('deferred_tools_delta', { addedNames: ['a'], readdedNames: ['b'] }))
      .toBe('Deferred tools +2');
  });

  it('uses addedTypes for agents', () => {
    expect(sum('agent_listing_delta', { addedTypes: ['Explore'] })).toBe('Agents +1');
  });

  it('marks a skills listing without pretending to count it', () => {
    expect(sum('skill_listing', { content: '- a: x\n- b: y' })).toBe('Skills listing');
  });
});
