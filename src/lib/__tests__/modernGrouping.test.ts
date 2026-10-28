import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { createDefaultConfig } from '../messageRenderingConfig';
import { buildModernItems, keepUnchangedItems, type ModernItem } from '../modernGrouping';

function prompt(text: string): JsonlNode {
  return { kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } } } as unknown as JsonlNode;
}

function assistant(blocks: unknown[]): JsonlNode {
  return {
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: { type: 'assistant', message: { role: 'assistant', content: blocks, stop_reason: null } },
  } as unknown as JsonlNode;
}

const thinking = (t: string) => assistant([{ type: 'thinking', thinking: t, signature: 's' }]);
const text = (t: string) => assistant([{ type: 'text', text: t }]);
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) =>
  assistant([{ type: 'tool_use', id, name, input }]);

function toolResult(id: string, content = 'ok', isError = false): JsonlNode {
  return {
    kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '',
    raw: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } },
  } as unknown as JsonlNode;
}

function system(subtype: string): JsonlNode {
  return { kind: 'system', subtype, sessionId: '', receivedAt: '', raw: { type: 'system', subtype, content: 'x' } } as unknown as JsonlNode;
}

const kinds = (items: ModernItem[]) => items.map((i) => i.kind);

describe('buildModernItems', () => {
  it('turns prompt → work → answer into bubble, one chain of thought, prose', () => {
    const p = prompt('fix it');
    const th = thinking('look first');
    const bash = toolUse('t1', 'Bash', { command: 'ls' });
    const bashRes = toolResult('t1', 'a\nb');
    const read = toolUse('t2', 'Read', { file_path: '/x/y.ts' });
    const readRes = toolResult('t2');
    const answer = text('Done.');
    const items = buildModernItems([p, th, bash, bashRes, read, readRes, answer], createDefaultConfig());

    expect(kinds(items)).toEqual(['prompt', 'work', 'text']);
    const work = items[1];
    if (work.kind !== 'work') throw new Error('not work');
    expect(work.entries.map((e) => e.type)).toEqual(['thinking', 'tool', 'tool']);
    const [, bashEntry] = work.entries;
    if (bashEntry.type !== 'tool') throw new Error('not tool');
    expect(bashEntry.name).toBe('Bash');
    expect(bashEntry.resultNode).toBe(bashRes);
    expect(bashEntry.resultText).toBe('a\nb');
    expect(work.nodes).toEqual([th, bash, bashRes, read, readRes]);
  });

  it('pulls AskUserQuestion and ExitPlanMode out of the work, absorbing their results', () => {
    const ask = toolUse('q1', 'AskUserQuestion', { questions: [] });
    const askRes = toolResult('q1', 'The user answered');
    const plan = toolUse('p1', 'ExitPlanMode', { plan: '# P' });
    const planRes = toolResult('p1', 'approved');
    const items = buildModernItems([thinking('hm'), ask, askRes, plan, planRes], createDefaultConfig());
    expect(kinds(items)).toEqual(['work', 'question', 'plan']);
    const q = items[1];
    const pl = items[2];
    if (q.kind !== 'question' || pl.kind !== 'plan') throw new Error('shape');
    expect(q.resultNode).toBe(askRes);
    expect(pl.markdown).toBe('# P');
    expect(pl.resultNode).toBe(planRes);
  });

  it('marks a tool with no result yet as pending and an errored one as error', () => {
    const items = buildModernItems(
      [toolUse('a', 'Bash'), toolUse('b', 'Bash'), toolResult('b', 'boom', true)],
      createDefaultConfig(),
    );
    const work = items[0];
    if (work.kind !== 'work') throw new Error('shape');
    expect(work.entries.map((e) => (e.type === 'tool' ? e.status : e.type))).toEqual(['pending', 'error']);
  });

  it('leaves out records hidden in Compact, inside a run and between items', () => {
    const cfg = createDefaultConfig();
    const hook = system('stop_hook_summary');
    const items = buildModernItems([toolUse('a', 'Bash'), toolResult('a'), hook, toolUse('b', 'Bash'), text('ok'), system('stop_hook_summary')], cfg);
    expect(kinds(items)).toEqual(['work', 'text']);
    const work = items[0];
    if (work.kind !== 'work') throw new Error('shape');
    expect(work.entries.map((e) => e.type)).toEqual(['tool', 'tool']);
  });

  it('keeps a shown non-conversation record as its own row', () => {
    const cfg = createDefaultConfig();
    cfg.kinds['system.stop_hook_summary'] = { visibility: 'always' };
    const hook = system('stop_hook_summary');
    const items = buildModernItems([prompt('go'), hook, text('ok')], cfg);
    expect(kinds(items)).toEqual(['prompt', 'other', 'text']);
  });

  it('draws a slash-command prompt as its command line, not the envelope', () => {
    const items = buildModernItems([prompt('<command-name>/usage</command-name>')], createDefaultConfig());
    expect(items.map((i) => (i.kind === 'prompt' ? i.text : i.kind))).toEqual(['/usage']);
  });

  it('keeps item keys stable when records are appended', () => {
    const nodes = [prompt('go'), thinking('a'), toolUse('a', 'Bash')];
    const before = buildModernItems(nodes, createDefaultConfig()).map((i) => i.key);
    const after = buildModernItems([...nodes, toolResult('a'), text('done')], createDefaultConfig()).map((i) => i.key);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('skips empty (redacted) thinking', () => {
    const items = buildModernItems([thinking(''), text('hi')], createDefaultConfig());
    expect(kinds(items)).toEqual(['text']);
  });
});

describe('keepUnchangedItems', () => {
  it('reuses the previous object for an item whose records did not change, so its row memo holds', () => {
    const p = prompt('go');
    const bash = toolUse('a', 'Bash');
    const first = buildModernItems([p, bash], createDefaultConfig());
    const res = toolResult('a');
    const done = text('done');
    const second = keepUnchangedItems(first, buildModernItems([p, bash, res, done], createDefaultConfig()));
    expect(second[0]).toBe(first[0]);
    // The work item gained a result, so it is new.
    expect(second[1]).not.toBe(first[1]);
    const third = keepUnchangedItems(second, buildModernItems([p, bash, res, done], createDefaultConfig()));
    expect(third.every((item, i) => item === second[i])).toBe(true);
  });
});

describe('buildModernItems — results outside the displayable rows', () => {
  it('pairs a tool with a result the display filter dropped', () => {
    const bash = toolUse('a', 'Bash');
    const res = toolResult('a', 'hello');
    // The transcript filters tool-result rows out (other formats reach them
    // through row lookups), so the full list is passed separately.
    const items = buildModernItems([bash], createDefaultConfig(), [bash, res]);
    const work = items[0];
    if (work.kind !== 'work' || work.entries[0].type !== 'tool') throw new Error('shape');
    expect(work.entries[0].status).toBe('done');
    expect(work.entries[0].resultText).toBe('hello');
  });
});

describe('buildModernItems — how long each thought took', () => {
  const at = (node: JsonlNode, iso: string) => ({ ...node, receivedAt: iso }) as JsonlNode;

  it('times a thinking block from the record before it', () => {
    const p = at(prompt('go'), '2026-10-28T10:00:00.000Z');
    const th = at(thinking('hmm'), '2026-10-28T10:00:05.000Z');
    const items = buildModernItems([p, th], createDefaultConfig());
    const work = items[1];
    if (work.kind !== 'work' || work.entries[0].type !== 'thinking') throw new Error('shape');
    expect(work.entries[0].ms).toBe(5000);
  });

  it('has no time when either side has no timestamp', () => {
    const items = buildModernItems([prompt('go'), thinking('hmm')], createDefaultConfig());
    const work = items[1];
    if (work.kind !== 'work' || work.entries[0].type !== 'thinking') throw new Error('shape');
    expect(work.entries[0].ms).toBeNull();
  });
});

describe('buildModernItems — thinking tokens and duration', () => {
  const tokens = (n: number) => ({
    kind: 'system', subtype: 'thinking_tokens', sessionId: '', receivedAt: '',
    raw: { type: 'system', subtype: 'thinking_tokens', estimated_tokens: n },
  }) as unknown as JsonlNode;

  it('puts the last token estimate before a thought on that thought, and draws no row for it', () => {
    const th = thinking('hm');
    const items = buildModernItems([tokens(200), tokens(608), th, text('done')], createDefaultConfig());
    expect(kinds(items)).toEqual(['work', 'text']);
    const work = items[0];
    if (work.kind !== 'work' || work.entries[0].type !== 'thinking') throw new Error('shape');
    expect(work.entries[0].tokens).toBe(608);
  });

  it('prefers the CLI\'s own thinking_duration_ms over the gap between records', () => {
    const th = { ...thinking('hm'), raw: { ...(thinking('hm') as unknown as { raw: object }).raw, thinking_duration_ms: 2675 } } as unknown as JsonlNode;
    const work = buildModernItems([th], createDefaultConfig())[0];
    if (work.kind !== 'work' || work.entries[0].type !== 'thinking') throw new Error('shape');
    expect(work.entries[0].ms).toBe(2675);
  });
});

describe('buildModernItems — notices', () => {
  const notification = (type: string, title: string, body: string) => ({
    kind: 'system', subtype: 'notification', sessionId: '', receivedAt: '',
    raw: { type: 'system', subtype: 'notification', notification_type: type, title, body },
  }) as unknown as JsonlNode;
  const interrupt = {
    kind: 'user', userKind: 'interrupt', sessionId: '', receivedAt: '',
    raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  } as unknown as JsonlNode;

  it('draws a stop as one notice, live (notification + marker) or reloaded (marker only)', () => {
    const live = buildModernItems([notification('stop', 'Stop Request', 'Response interrupted — session still active'), system('stop_hook_summary'), interrupt], createDefaultConfig());
    expect(live.map((i) => i.kind === 'notice' ? `${i.tone}:${i.text}` : i.kind)).toEqual(['stop:Response interrupted']);
    const reloaded = buildModernItems([interrupt], createDefaultConfig());
    expect(reloaded.map((i) => i.kind === 'notice' ? `${i.tone}:${i.text}` : i.kind)).toEqual(['stop:Response interrupted']);
  });

  it('draws other notifications as notices with their title and body', () => {
    const items = buildModernItems([notification('error', 'Session Error', 'Error: boom')], createDefaultConfig());
    expect(items.map((i) => i.kind === 'notice' ? `${i.tone}:${i.text}` : i.kind)).toEqual(['error:Session Error — Error: boom']);
  });
});

describe('buildModernItems — a question waiting on you', () => {
  it('draws no question until its answer lands: the live card is the only copy, as in Compact', () => {
    const ask = toolUse('q1', 'AskUserQuestion', { questions: [] });
    expect(kinds(buildModernItems([prompt('go'), ask], createDefaultConfig()))).toEqual(['prompt']);
    expect(kinds(buildModernItems([prompt('go'), ask, toolResult('q1', 'answered')], createDefaultConfig()))).toEqual(['prompt', 'question']);
  });

  it('treats a plan waiting for approval the same way', () => {
    const plan = toolUse('p1', 'ExitPlanMode', { plan: '# P' });
    expect(kinds(buildModernItems([prompt('go'), plan], createDefaultConfig()))).toEqual(['prompt']);
  });
});

describe('buildModernItems — prompts that are not plain text', () => {
  const userNode = (userKind: string, content: unknown, extra: Record<string, unknown> = {}) => ({
    kind: 'user', userKind, sessionId: '', receivedAt: '',
    raw: { type: 'user', message: { role: 'user', content }, ...extra },
  } as unknown as JsonlNode);

  it('draws a prompt with pasted images as a bubble carrying them', () => {
    const items = buildModernItems([userNode('prompt', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'look at this' },
    ])], createDefaultConfig());
    expect(kinds(items)).toEqual(['prompt']);
    const p = items[0];
    if (p.kind !== 'prompt') throw new Error('shape');
    expect(p.text).toBe('look at this');
    expect(p.images).toEqual([{ src: 'data:image/png;base64,AAAA', mediaType: 'image/png' }]);
  });

  it('draws a built-in slash command echo as a command bubble', () => {
    const echo = userNode('local-command', [{ type: 'text', text: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the plan</command-args>' }]);
    const items = buildModernItems([echo], createDefaultConfig());
    expect(kinds(items)).toEqual(['prompt']);
    const p = items[0];
    if (p.kind !== 'prompt') throw new Error('shape');
    expect(p.text).toBe('/compact keep the plan');
    expect(p.command).toBe(true);
  });

  it('draws a skill command echo as a command bubble too', () => {
    const echo = userNode('prompt', [{ type: 'text', text: '<command-message>review</command-message>\n<command-name>/review</command-name>' }]);
    const p = buildModernItems([echo], createDefaultConfig())[0];
    if (p?.kind !== 'prompt') throw new Error('shape');
    expect(p.text).toBe('/review');
    expect(p.command).toBe(true);
  });
});

describe('buildModernItems — compaction', () => {
  const boundary = {
    kind: 'system', subtype: 'compact_boundary', sessionId: '', receivedAt: '',
    raw: { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 777000, postTokens: 27000, durationMs: 70340 } },
  } as unknown as JsonlNode;
  const summary = {
    kind: 'user', userKind: 'compact-summary', sessionId: '', receivedAt: '',
    raw: { type: 'user', isCompactSummary: true, message: { role: 'user', content: [{ type: 'text', text: 'This session is being continued…' }] } },
  } as unknown as JsonlNode;

  it('folds the boundary and its summary into one compaction line', () => {
    const items = buildModernItems([text('done'), boundary, summary], createDefaultConfig());
    expect(kinds(items)).toEqual(['text', 'compaction']);
    const c = items[1];
    if (c.kind !== 'compaction') throw new Error('shape');
    expect(c.detail).toBe('manual · 777k → 27k tokens · 1m 10s');
    expect(c.summary).toBe('This session is being continued…');
    expect(c.summaryNode).toBe(summary);
  });

  it('draws a summary with no boundary before it as its own compaction line', () => {
    const items = buildModernItems([summary], createDefaultConfig());
    expect(kinds(items)).toEqual(['compaction']);
  });
});
