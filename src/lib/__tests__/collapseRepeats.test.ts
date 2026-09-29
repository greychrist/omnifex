import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { createDefaultConfig, KIND_REGISTRY } from '../messageRenderingConfig';
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

// ── latestInRun ────────────────────────────────────────────────────────────
// For kinds that re-send a whole snapshot rather than a change. The CLI emits
// one `thinking_tokens` ping every few hundred tokens and `estimated_tokens`
// is the burst's RUNNING total, so the last ping of a burst carries the
// turn's total and every earlier one is a strictly-worse duplicate. A run
// ends at the first non-system message. A pure filter: nothing synthetic is
// injected, so the output stays a faithful subset of what the CLI emitted.
describe('collapseRepeats — latestInRun (thinking_tokens)', () => {
  const cfg = createDefaultConfig();

  it('collapses a burst to its last ping, which carries the turn total', () => {
    const out = collapseRepeats(
      [thinkingTokens(50), thinkingTokens(100), thinkingTokens(150), thinkingTokens(1300)],
      cfg,
    );
    expect(tokensOf(out)).toEqual([1300]);
  });

  it('keeps a lone ping', () => {
    expect(tokensOf(collapseRepeats([thinkingTokens(800)], cfg))).toEqual([800]);
  });

  it('keeps one ping per burst when bursts are split by an assistant message', () => {
    const out = collapseRepeats(
      [thinkingTokens(50), thinkingTokens(400), assistantText('let me check'), thinkingTokens(75), thinkingTokens(900)],
      cfg,
    );
    expect(tokensOf(out)).toEqual([400, 900]);
  });

  it('treats intervening system messages as part of the same burst', () => {
    const status = system('status', { status: 'requesting' });
    const out = collapseRepeats([thinkingTokens(50), status, thinkingTokens(600)], cfg);
    expect(tokensOf(out)).toEqual([600]);
    expect(out).toContain(status);
  });

  it('does not drop the trailing ping of an in-flight burst', () => {
    const out = collapseRepeats([userText('hi'), thinkingTokens(50), thinkingTokens(100)], cfg);
    expect(tokensOf(out)).toEqual([100]);
  });

  it('collapses each kind independently within one run', () => {
    const snap = (n: number) => system('background_tasks_changed', { tasks: new Array(n).fill({}) });
    const out = collapseRepeats([thinkingTokens(50), snap(1), thinkingTokens(90), snap(2)], cfg);
    expect(tokensOf(out)).toEqual([90]);
    expect(field(out, 'background_tasks_changed', 'tasks')).toHaveLength(1);
  });
});

// ── onChange ───────────────────────────────────────────────────────────────
// For single-value kinds the CLI re-sends unchanged: `session_title_changed`
// arrives at startup for every resume of a named session.
describe('collapseRepeats — onChange (session_title_changed)', () => {
  const cfg = createDefaultConfig();

  it('keeps only the rows where the value changes', () => {
    const out = collapseRepeats(
      [titleChanged('A'), userText('hi'), titleChanged('A'), titleChanged('B'), titleChanged('B'), titleChanged('A')],
      cfg,
    );
    expect(field(out, 'session_title_changed', 'title')).toEqual(['A', 'B', 'A']);
  });
});

describe('collapseRepeats — user choice', () => {
  it('shows every repeat when the kind is set to Show all', () => {
    const cfg = createDefaultConfig();
    cfg.kinds['system.thinking_tokens'] = { collapseRepeats: false };
    const out = collapseRepeats([thinkingTokens(50), thinkingTokens(100)], cfg);
    expect(tokensOf(out)).toEqual([50, 100]);
  });

  it('leaves kinds without a rule alone', () => {
    const a = system('hook_started');
    const b = system('hook_started');
    expect(collapseRepeats([a, b], createDefaultConfig())).toEqual([a, b]);
  });

  it('returns the same array when nothing collapses', () => {
    const msgs = [userText('hi'), assistantText('yo')];
    expect(collapseRepeats(msgs, createDefaultConfig())).toBe(msgs);
  });
});

describe('collapse rules in the registry', () => {
  it('name a field for every onChange rule', () => {
    for (const def of Object.values(KIND_REGISTRY)) {
      if (def.collapse?.mode === 'onChange') expect(def.collapse.field).toBeTruthy();
    }
  });
});

describe('collapseRepeats — persistence', () => {
  it('survives a save and reload', async () => {
    const { mergeConfig } = await import('../messageRenderingConfig');
    const cfg = createDefaultConfig();
    cfg.kinds['system.thinking_tokens'] = { collapseRepeats: false };
    const reloaded = mergeConfig(JSON.parse(JSON.stringify(cfg)));
    expect(reloaded.kinds['system.thinking_tokens']).toEqual({ collapseRepeats: false });
  });
});
