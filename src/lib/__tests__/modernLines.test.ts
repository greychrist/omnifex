import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { createDefaultConfig } from '../messageRenderingConfig';
import { modernLineOf } from '../modernLines';

const cfg = createDefaultConfig();
const line = (node: unknown) => modernLineOf(node as JsonlNode, [node as JsonlNode], cfg);
const sys = (subtype: string, extra: Record<string, unknown> = {}) => ({
  kind: 'system', subtype, sessionId: '', receivedAt: '2026-11-02T00:00:00Z', raw: { type: 'system', subtype, ...extra },
});

describe('modernLineOf — what Modern draws instead of a Compact card', () => {
  it('names a persisted permission-mode change by its picker label', () => {
    expect(line({ kind: 'permission-mode', sessionId: '', raw: { type: 'permission-mode', permissionMode: 'acceptEdits' } }))
      .toMatchObject({ icon: 'ShieldCheck', title: 'Permission mode', detail: 'Accept Edits' });
    expect(line({ kind: 'permission-mode', sessionId: '', raw: { type: 'permission-mode', permissionMode: 'auto' } }))
      .toMatchObject({ title: 'Permission mode', detail: 'Auto' });
  });

  it('names the live mode, effort and model markers the same way', () => {
    const cc = (control: string, value: string) => ({ kind: 'control-change', control, value, sessionId: '', receivedAt: '' });
    expect(line(cc('permission', 'plan'))).toMatchObject({ icon: 'ShieldCheck', title: 'Permission mode', detail: 'Plan' });
    expect(line(cc('effort', 'high'))).toMatchObject({ title: 'Effort', detail: 'High' });
    expect(line(cc('model', 'claude-opus-5-5'))).toMatchObject({ title: 'Model', detail: 'claude-opus-5-5' });
  });

  it('draws a slash command\'s output in mono under its command name, open', () => {
    const l = line(sys('local_command', { content: '<local-command-stdout>Total cost: $1.20</local-command-stdout>', commandRun: { command: 'cost' } }));
    expect(l).toMatchObject({ title: '/cost', body: 'Total cost: $1.20', mono: true, fold: false });
  });

  it('puts a short system text beside the title, and marks an API error', () => {
    expect(line(sys('api_error', { content: 'Overloaded' }))).toMatchObject({ title: 'API error', detail: 'Overloaded', tone: 'error' });
  });

  it('folds a long or multi-line system text under the title', () => {
    const l = line(sys('informational', { content: 'first line\nsecond line' }));
    expect(l).toMatchObject({ body: 'first line\nsecond line', fold: true });
    expect(l?.detail).toBeUndefined();
  });

  it('titles a context attachment by its ledger summary', () => {
    const l = line({ kind: 'attachment', sessionId: '', receivedAt: '', raw: { type: 'attachment', attachment: { type: 'nested_memory', path: '/r/src/CLAUDE.md' } } });
    expect(l?.title).toBe('Nested memory — src/CLAUDE.md');
  });

  it('keeps an unrecognized record visible: named, with its JSON folded', () => {
    const l = line({ kind: 'unknown', sessionId: '', receivedAt: null, raw: { type: 'brand-new', x: 1 } });
    expect(l).toMatchObject({ title: 'Unrecognized record: brand-new', mono: true, fold: true });
    // Amber, as the context nearing its limit is: worth noticing, not an error.
    expect(l?.tone).toBe('warn');
    // An unknown system frame names its subtype too.
    expect(line({ kind: 'unknown', sessionId: '', receivedAt: null, raw: { type: 'system', subtype: 'brand_new' } }))
      .toMatchObject({ title: 'Unrecognized record: system.brand_new', tone: 'warn' });
    expect(l?.body).toContain('"brand-new"');
  });

  it('leaves conversation content to the message renderer', () => {
    expect(line({ kind: 'assistant', sessionId: '', receivedAt: '', raw: { type: 'assistant', message: { content: [{ type: 'image' }] } } })).toBeNull();
  });
});
