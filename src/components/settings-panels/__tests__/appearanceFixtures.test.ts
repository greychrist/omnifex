import { describe, it, expect } from 'vitest';
import { KIND_REGISTRY } from '@/lib/messageRenderingConfig';
import { KIND_FIXTURES, previewTextForKindId } from '../appearance/fixtures';

// The Appearance tree renders one row per KIND_REGISTRY entry, and each row
// previews itself with fixture text. A registry entry added without a fixture
// still renders — as the literal string "(no preview available)", which reads
// like a bug in the settings screen rather than a missing table row.
describe('Appearance preview fixtures', () => {
  const EXEMPT = new Set([
    // Bookkeeping side-line markers: the preview draws them from the
    // category fixture, not per-kind text.
    'permission-mode', 'last-prompt', 'ai-title', 'queue-operation',
    'file-history-snapshot',
    'control.effort', 'control.model', 'control.permission',
  ]);

  it('every registry kind that previews per-kind has fixture text', () => {
    const missing = Object.keys(KIND_REGISTRY).filter(
      (id) => !EXEMPT.has(id) && !(id in KIND_FIXTURES),
    );
    expect(missing).toEqual([]);
  });

  it('previews a queued feedback draft as a draft, not the empty fallback', () => {
    const text = previewTextForKindId('system.feedback_draft_queued');
    expect(text).not.toBe('(no preview available)');
    expect(text.length).toBeGreaterThan(0);
  });
});
