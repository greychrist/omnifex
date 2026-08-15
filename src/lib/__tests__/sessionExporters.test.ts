import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportAsMarkdown } from '../sessionExporters';
import type { JsonlNode } from '@/types/jsonl';

/** The exporter's only output channel is the clipboard. */
function captureClipboard(): { text: () => string } {
  let captured = '';
  vi.stubGlobal('navigator', {
    clipboard: {
      writeText: (t: string) => {
        captured = t;
        return Promise.resolve();
      },
    },
  });
  return { text: () => captured };
}

function assistantNode(usage: Record<string, number>): JsonlNode {
  return {
    kind: 'assistant',
    sessionId: 'sess-1',
    receivedAt: '2026-08-15T10:00:00Z',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello.' }],
        usage,
      },
    },
  } as unknown as JsonlNode;
}

describe('exportAsMarkdown token counts', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports total input, not the uncached remainder', () => {
    // Same defect the in-app footer had: `input_tokens` alone is what is left
    // after prompt caching, so an export claimed "2 in" for a 45,435-token read.
    const clip = captureClipboard();
    const node = assistantNode({
      input_tokens: 2,
      cache_read_input_tokens: 20496,
      cache_creation_input_tokens: 24937,
      output_tokens: 644,
    });

    return exportAsMarkdown([node], '/tmp/project').then(() => {
      expect(clip.text()).toContain('*Tokens: 45,435 in, 644 out*');
      expect(clip.text()).not.toContain('2 in');
    });
  });
});
