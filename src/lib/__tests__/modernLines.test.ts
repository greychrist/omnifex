import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { createDefaultConfig, resolveKind } from '../messageRenderingConfig';
import { classifyJsonlLine } from '../jsonlClassifier';
import { ALL_KIND_RECORDS, KIND_OF_RECORD } from './fixtures/allKindRecords';
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

  // A change line wears the new value's color, as an answered question wears
  // its purple: the picker's for a permission mode or effort level, the Cost
  // Report's for a model.
  it('colors a mode, effort or model change by its new value', () => {
    const cc = (control: string, value: string) => ({ kind: 'control-change', control, value, sessionId: '', receivedAt: '' });
    expect(line(cc('permission', 'plan'))?.accent).toEqual({ kind: 'css', color: 'var(--color-teal-600)' });
    expect(line(cc('permission', 'bypassPermissions'))?.accent).toEqual({ kind: 'css', color: 'var(--color-red-600)' });
    expect(line(cc('effort', 'high'))?.accent).toEqual({ kind: 'css', color: 'var(--color-yellow-600)' });
    expect(line(cc('effort', 'max'))?.accent).toEqual({ kind: 'css', color: 'var(--color-red-600)' });
    expect(line(cc('model', 'claude-opus-5-5'))?.accent).toEqual({ kind: 'model', model: 'claude-opus-5-5' });
    expect(line({ kind: 'permission-mode', sessionId: '', raw: { type: 'permission-mode', permissionMode: 'acceptEdits' } })?.accent)
      .toEqual({ kind: 'css', color: 'var(--color-purple-600)' });
  });

  // Since 2026-11-18 a line with no color of its own wears its kind's, from
  // Settings › Chats, as the classic card did.
  it('gives an unknown value and every other record its kind color', () => {
    const cc = (control: string, value: string) => ({ kind: 'control-change', control, value, sessionId: '', receivedAt: '' });
    expect(line(cc('permission', 'someNewMode')).accent).toEqual({ kind: 'css', color: resolveKind(cfg, 'control.permission').accentColor });
    expect(line(cc('effort', 'ultra')).accent).toEqual({ kind: 'css', color: resolveKind(cfg, 'control.effort').accentColor });
    expect(line(sys('informational', { content: 'hi' })).accent).toEqual({ kind: 'css', color: resolveKind(cfg, 'system.unknown').accentColor });
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

  // Expanded draws every record, but "Unrecognized" is reserved for types
  // nothing knows: the CLI review leans on that card to spot new ones.
  it('draws known CLI bookkeeping as a muted state line, not as unrecognized', () => {
    const l = line({ kind: 'unknown', sessionId: '', receivedAt: null, raw: { type: 'session-owner', accountUuid: 'a', sessionId: 's' } });
    expect(l).toMatchObject({ title: 'CLI state: session-owner', mono: true, fold: true });
    expect(l?.tone).toBeUndefined();
    expect(l?.body).toContain('"accountUuid"');
    // Its own kind, pale blue by default (Settings › Chats can change it).
    expect(l?.accent).toEqual({ kind: 'css', color: '#93c5fd' });
    // An automation glyph, not the unknown kind's question mark.
    expect(l?.icon).toBe('Workflow');
  });

  it('draws a task lifecycle frame as a task line, not as unrecognized', () => {
    const started = line({ kind: 'unknown', sessionId: '', receivedAt: 't', raw: {
      type: 'system', subtype: 'task_started', task_type: 'local_bash', description: 'Build the link',
    } });
    expect(started).toMatchObject({ title: 'Task started', detail: 'local_bash · Build the link', mono: true, fold: true });
    expect(started?.tone).toBeUndefined();
    // Its own kind: the CLI state blue and a checklist glyph, not the
    // unknown kind's orange question mark.
    expect(started?.accent).toEqual({ kind: 'css', color: '#93c5fd' });
    expect(started?.icon).toBe('ListChecks');
    const done = line({ kind: 'unknown', sessionId: '', receivedAt: 't', raw: {
      type: 'system', subtype: 'task_notification', status: 'completed',
    } });
    expect(done).toMatchObject({ title: 'Task notification', detail: 'completed' });
    expect(done?.tone).toBeUndefined();
  });

  // A record with no text to show, such as an assistant image, is still
  // drawn: its raw JSON, folded.
  it('draws a record with no text as its folded raw JSON', () => {
    expect(line({ kind: 'assistant', sessionId: '', receivedAt: '', raw: { type: 'assistant', message: { content: [{ type: 'image' }] } } }))
      .toMatchObject({ title: 'Assistant text', mono: true, fold: true });
  });
});

// Standard and Expanded (2026-11-18): the classic card is gone, so every
// record Modern does not draw as conversation is a line, in its kind's icon
// and color from Settings › Chats.
describe('modernLineOf — every record has a line', () => {
  const fixtureCfg = createDefaultConfig();
  const recordOfKind = (kindId: string): JsonlNode => {
    const node = ALL_KIND_RECORDS.find((n) => KIND_OF_RECORD.get(n) === kindId);
    if (!node) throw new Error(`no fixture record for ${kindId}`);
    return node;
  };

  it.each(['user.subagentPrompt', 'user.skillInjection', 'user.systemContext', 'user.taskNotification',
    'user.coordinatorMessage'])('draws %s as a line in its kind icon and color', (kindId) => {
    const l = modernLineOf(recordOfKind(kindId), ALL_KIND_RECORDS, fixtureCfg);
    expect(l).not.toBeNull();
    expect(l.icon).toBe(resolveKind(fixtureCfg, kindId).icon);
    expect(l.accent).toEqual({ kind: 'css', color: resolveKind(fixtureCfg, kindId).accentColor });
    expect(l.body?.length ?? l.detail?.length ?? 0).toBeGreaterThan(0);
  });

  it('draws the live permission record and the legacy summary record as lines', () => {
    expect(modernLineOf(recordOfKind('permission.request'), ALL_KIND_RECORDS, fixtureCfg))
      .toMatchObject({ title: 'Permission request', detail: 'Bash' });
    expect(modernLineOf(recordOfKind('summary.compaction'), ALL_KIND_RECORDS, fixtureCfg))
      .toMatchObject({ title: 'Conversation summary', detail: 'Login fix' });
  });

  it('draws a tool result outside any work run as a folded line', () => {
    const orphan = { kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '2026-11-18T00:00:00Z',
      raw: { type: 'user', uuid: 'orphan', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'line one\nline two' }] } } } as unknown as JsonlNode;
    expect(modernLineOf(orphan, [orphan], fixtureCfg)).toMatchObject({ title: 'Tool result', body: 'line one\nline two', fold: true });
  });

  it('draws an unregistered record as an unrecognized line', () => {
    const l = modernLineOf(classifyJsonlLine({ type: 'brand_new', uuid: 'x', timestamp: '2026-11-18T00:00:00Z' })!, [], fixtureCfg);
    expect(l.title).toBe('Unrecognized record: brand_new');
    expect(l.tone).toBe('warn');
  });
});
