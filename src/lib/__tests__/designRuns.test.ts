import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import type { WorkEntry } from '@/lib/modernGrouping';
import { foldDesignRuns, designRunSummary, isArtifactTool } from '@/lib/designRuns';

const node = (id: string) => ({ kind: 'assistant', raw: { uuid: id } }) as unknown as JsonlNode;
let n = 0;
function tool(name: string, input: Record<string, unknown> = {}, resultText?: string, status: 'done' | 'error' | 'pending' = 'done'): WorkEntry {
  n += 1;
  return { type: 'tool', key: `k${n}`, node: node(`n${n}`), id: `t${n}`, name, input, status, resultText } as WorkEntry;
}
const think = (): WorkEntry => { n += 1; return { type: 'thinking', key: `k${n}`, node: node(`n${n}`), text: 'hmm', ms: null, tokens: null }; };
const A = (t: string) => `mcp__claude-artifacts__${t}`;
const SCRATCH = '/private/tmp/claude-501/p/s/scratchpad/habit/project';

describe('isArtifactTool', () => {
  it('knows the built-in tools and the claude-artifacts server', () => {
    expect(isArtifactTool('Artifact')).toBe(true);
    expect(isArtifactTool('ArtifactData')).toBe(true);
    expect(isArtifactTool(A('guide'))).toBe(true);
    expect(isArtifactTool('mcp__claude-artifactsx__guide')).toBe(false);
    expect(isArtifactTool('Read')).toBe(false);
  });
});

describe('foldDesignRuns', () => {
  it('folds a design run, with the tool loading before it and the scratchpad work inside it', () => {
    const before = think();
    const load = tool('ToolSearch', { query: `select:${A('list_types')},${A('create_from_type')}` });
    const guide = tool(A('guide'), { topic: 'design' });
    const mid = think();
    const write = tool('Write', { file_path: `${SCRATCH}/Main.dc.html`, content: '<html>' });
    const bash = tool('Bash', { command: `R=${SCRATCH}; cat > $R/canvas.json` });
    const publish = tool(A('publish_files'), {});
    const after = think();
    const out = foldDesignRuns([before, load, guide, mid, write, bash, publish, after]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(before);
    expect(out[2]).toBe(after);
    const run = out[1];
    expect(run.type).toBe('design');
    if (run.type !== 'design') return;
    expect(run.entries).toEqual([load, guide, mid, write, bash, publish]);
  });

  it('stops at work that is not the design\'s, and starts a new run after it', () => {
    const a = tool(A('publish_version'));
    const edit = tool('Edit', { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' });
    const b = tool(A('publish_version'));
    const out = foldDesignRuns([a, edit, b]);
    expect(out.map((e) => e.type)).toEqual(['design', 'tool', 'design']);
  });

  it('takes the scratchpad files written just before the first design call', () => {
    const t = think();
    const write = tool('Write', { file_path: `${SCRATCH}/Main.dc.html`, content: '<html>' });
    const publish = tool(A('publish_files'));
    const out = foldDesignRuns([t, write, publish]);
    expect(out.map((e) => e.type)).toEqual(['thinking', 'design']);
  });

  it('reaches back past bookkeeping for the set-up, but does not start on it', () => {
    const progress0 = tool('mcp__omnifex__progress', { done: 0, total: 3 });
    const write = tool('Write', { file_path: `${SCRATCH}/Main.dc.html`, content: '<html>' });
    const progress1 = tool('mcp__omnifex__progress', { done: 1, total: 3 });
    const publish = tool(A('publish_files'));
    const out = foldDesignRuns([progress0, write, progress1, publish]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(progress0);
    expect(out[1].type === 'design' && out[1].entries).toEqual([write, progress1, publish]);
  });

  it('is not broken by progress or todo bookkeeping', () => {
    const out = foldDesignRuns([
      tool(A('create_from_type'), { title: 'X' }),
      tool('mcp__omnifex__progress', { done: 1, total: 2 }),
      tool('TodoWrite', { todos: [] }),
      tool(A('publish_files')),
    ]);
    expect(out.map((e) => e.type)).toEqual(['design']);
  });

  it('does not take thoughts after the last design call', () => {
    const a = tool(A('guide'));
    const t = think();
    expect(foldDesignRuns([a, t]).map((e) => e.type)).toEqual(['design', 'thinking']);
  });

  it('leaves a run with no design call alone', () => {
    const entries = [think(), tool('Read', { file_path: '/a' })];
    expect(foldDesignRuns(entries)).toEqual(entries);
  });
});

describe('designRunSummary', () => {
  const published = (title: string, url: string) =>
    `<artifact-content-authored-by-others/>\n{"slug":"x","title":"${title}","url":"${url}","seq":2}`;

  it('takes the link and title from the last publish, not from a listing of types', () => {
    const list = tool(A('list_types'), {}, '{"types":[{"url":"https://claude.ai/artifact/TYPEPAGE"}]}');
    const create = tool(A('create_from_type'), { title: 'Habit Tracker Today' }, '{"slug":"s"}');
    const pub = tool(A('publish_files'), {}, published('Habit Tracker Today', 'https://claude.ai/artifact/9aQk'));
    const s = designRunSummary([list, create, pub]);
    expect(s).toEqual({ title: 'Habit Tracker Today', url: 'https://claude.ai/artifact/9aQk', state: 'done' });
  });

  it('names it from create_from_type until something is published', () => {
    const create = tool(A('create_from_type'), { title: 'Deck' }, undefined, 'pending');
    expect(designRunSummary([create])).toEqual({ title: 'Deck', url: null, state: 'running' });
    const created = tool(A('create_from_type'), { title: 'Deck' }, '{"slug":"s"}');
    expect(designRunSummary([created])).toEqual({ title: 'Deck', url: null, state: 'done' });
  });

  it('is failed when the last design call failed', () => {
    const pub = tool(A('publish_version'), {}, 'boom', 'error');
    expect(designRunSummary([pub]).state).toBe('error');
  });

  it('is done when a failure was retried and published', () => {
    const bad = tool(A('publish_version'), {}, 'boom', 'error');
    const good = tool(A('publish_version'), {}, published('X', 'https://claude.ai/artifact/X1'));
    expect(designRunSummary([bad, good])).toEqual({ title: 'X', url: 'https://claude.ai/artifact/X1', state: 'done' });
  });
});
