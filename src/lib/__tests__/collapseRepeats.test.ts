import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { KIND_REGISTRY } from '../messageRenderingConfig';
import { collapseRepeats } from '../collapseRepeats';

const system = (subtype: string, extra: Record<string, unknown> = {}): JsonlNode =>
  ({
    kind: 'system', subtype, sessionId: '', receivedAt: '',
    raw: { type: 'system', subtype, ...extra },
  }) as unknown as JsonlNode;

const thinkingTokens = (estimated_tokens: number) => system('thinking_tokens', { estimated_tokens });
const titleChanged = (title: string) => system('session_title_changed', { title });

const assistantText = (text: string): JsonlNode =>
  ({
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }) as unknown as JsonlNode;

const userText = (text: string): JsonlNode =>
  ({
    kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '',
    raw: { type: 'user', message: { role: 'user', content: text } },
  }) as unknown as JsonlNode;

const field = (nodes: JsonlNode[], subtype: string, key: string): unknown[] =>
  nodes
    .filter((n) => n.kind === 'system' && n.subtype === subtype)
    .map((n) => (n as unknown as { raw: Record<string, unknown> }).raw[key]);

const tokensOf = (nodes: JsonlNode[]) => field(nodes, 'thinking_tokens', 'estimated_tokens');

// The CLI pings `thinking_tokens` every few hundred tokens and
// `estimated_tokens` is the burst's RUNNING total, so the last ping carries it.
describe('collapseRepeats — latestInRun (thinking_tokens)', () => {

  it('collapses a burst to its last ping, which carries the turn total', () => {
    const out = collapseRepeats(
      [thinkingTokens(50), thinkingTokens(100), thinkingTokens(150), thinkingTokens(1300)]
    );
    expect(tokensOf(out)).toEqual([1300]);
  });

  it('keeps a lone ping', () => {
    expect(tokensOf(collapseRepeats([thinkingTokens(800)]))).toEqual([800]);
  });

  it('keeps one ping per burst when bursts are split by an assistant message', () => {
    const out = collapseRepeats(
      [thinkingTokens(50), thinkingTokens(400), assistantText('let me check'), thinkingTokens(75), thinkingTokens(900)]
    );
    expect(tokensOf(out)).toEqual([400, 900]);
  });

  it('treats intervening system messages as part of the same burst', () => {
    const status = system('status', { status: 'requesting' });
    const out = collapseRepeats([thinkingTokens(50), status, thinkingTokens(600)]);
    expect(tokensOf(out)).toEqual([600]);
    expect(out).toContain(status);
  });

  it('does not drop the trailing ping of an in-flight burst', () => {
    const out = collapseRepeats([userText('hi'), thinkingTokens(50), thinkingTokens(100)]);
    expect(tokensOf(out)).toEqual([100]);
  });

  it('collapses each kind independently within one run', () => {
    const snap = (n: number) => system('background_tasks_changed', { tasks: new Array(n).fill({}) });
    const out = collapseRepeats([thinkingTokens(50), snap(1), thinkingTokens(90), snap(2)]);
    expect(tokensOf(out)).toEqual([90]);
    expect(field(out, 'background_tasks_changed', 'tasks')).toHaveLength(1);
  });
});

// The CLI re-sends `session_title_changed` unchanged on every resume of a
// named session.
describe('collapseRepeats — onChange (session_title_changed)', () => {

  it('keeps only the rows where the value changes', () => {
    const out = collapseRepeats(
      [titleChanged('A'), userText('hi'), titleChanged('A'), titleChanged('B'), titleChanged('B'), titleChanged('A')]
    );
    expect(field(out, 'session_title_changed', 'title')).toEqual(['A', 'B', 'A']);
  });
});

describe('collapseRepeats — kinds without a rule', () => {
  it('leaves kinds without a rule alone', () => {
    const a = system('hook_started');
    const b = system('hook_started');
    expect(collapseRepeats([a, b])).toEqual([a, b]);
  });

  it('returns the same array when nothing collapses', () => {
    const msgs = [userText('hi'), assistantText('yo')];
    expect(collapseRepeats(msgs)).toBe(msgs);
  });
});

describe('collapse rules in the registry', () => {
  it('name a field for every onChange rule', () => {
    for (const def of Object.values(KIND_REGISTRY)) {
      if (def.collapse?.mode === 'onChange') expect(def.collapse.field).toBeTruthy();
    }
  });
});


// The CLI re-writes the permission mode and custom title on every metadata
// save.
describe('collapseRepeats — permission-mode and custom-title re-stamps', () => {
  const mode = (permissionMode: string): JsonlNode =>
    ({ kind: 'permission-mode', sessionId: '', raw: { type: 'permission-mode', permissionMode } }) as unknown as JsonlNode;
  const renamed = (customTitle: string): JsonlNode =>
    ({ kind: 'custom-title', sessionId: '', raw: { type: 'custom-title', customTitle } }) as unknown as JsonlNode;
  const modes = (nodes: JsonlNode[]) => nodes.filter((n) => n.kind === 'permission-mode').map((n) => (n.raw as { permissionMode: string }).permissionMode);
  const titles = (nodes: JsonlNode[]) => nodes.filter((n) => n.kind === 'custom-title').map((n) => (n.raw as { customTitle: string }).customTitle);

  const stream = [
    mode('auto'), userText('a'), mode('auto'), assistantText('b'), mode('acceptEdits'), mode('acceptEdits'), mode('auto'),
    renamed('Working on Jira App'), userText('c'), renamed('Working on Jira App'), renamed('Jira app v2'),
  ];

  it('keeps the first and each change in Compact and Modern, across other records', () => {
    for (const viewMode of ['standard'] as const) {
      const out = collapseRepeats(stream, viewMode);
      expect(modes(out)).toEqual(['auto', 'acceptEdits', 'auto']);
      expect(titles(out)).toEqual(['Working on Jira App', 'Jira app v2']);
      expect(out.filter((n) => n.kind === 'user' || n.kind === 'assistant')).toHaveLength(3);
    }
  });

  it('shows every record in Verbose and All', () => {
    for (const viewMode of ['expanded'] as const) {
      expect(collapseRepeats(stream, viewMode)).toBe(stream);
    }
  });

  it('declares the rule on both kinds, so Standard tidies both', () => {
    expect(KIND_REGISTRY['permission-mode'].collapse).toEqual({ mode: 'onChange', field: 'permissionMode', onlyIn: ['standard'] });
    expect(KIND_REGISTRY['custom-title'].collapse).toEqual({ mode: 'onChange', field: 'customTitle', onlyIn: ['standard'] });
  });

  it('leaves the existing system rules on in every format', () => {
    const burst = [thinkingTokens(10), thinkingTokens(20)];
    expect(tokensOf(collapseRepeats(burst, 'expanded'))).toEqual([20]);
  });
});
