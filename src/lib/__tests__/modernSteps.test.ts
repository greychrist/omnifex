import { describe, it, expect } from 'vitest';
import { describeToolStep, reasoningTitle, stepKind, thinkingTokensLabel, traceHeader, webSources } from '../modernSteps';

describe('describeToolStep — verbs follow the step, as in shadcn Trace', () => {
  it('reads a file: reading, read, failed to read', () => {
    const input = { file_path: '/a/b/c.ts', offset: 40 };
    expect(describeToolStep('Read', input, 'running').title).toBe('Reading c.ts');
    expect(describeToolStep('Read', input, 'done')).toEqual({ title: 'Read c.ts', badges: ['from line 40'] });
    expect(describeToolStep('Read', input, 'error').title).toBe('Failed to read c.ts');
  });

  it('edits and writes', () => {
    expect(describeToolStep('Edit', { file_path: '/a/x.ts' }, 'done').title).toBe('Edited x.ts');
    expect(describeToolStep('Write', { file_path: '/a/new.md' }, 'running').title).toBe('Writing new.md');
  });

  it('searches, with the path as a code badge', () => {
    expect(describeToolStep('Grep', { pattern: 'foo', path: 'src' }, 'done'))
      .toEqual({ title: 'Searched the code for foo', badges: ['src'], codeBadges: true });
    expect(describeToolStep('Glob', { pattern: '**/*.ts' }, 'running').title).toBe('Finding files matching **/*.ts');
    expect(describeToolStep('WebSearch', { query: 'x' }, 'done').title).toBe('Searched the web for x');
    expect(describeToolStep('WebFetch', { url: 'https://example.com/a' }, 'done'))
      .toEqual({ title: 'Read a web page', badges: ['example.com'] });
  });

  it('names the command that ran, as Trace does, not the model\'s description of it', () => {
    expect(describeToolStep('Bash', { command: 'npm test', description: 'Run the tests' }, 'done').title).toBe('Ran npm test');
    expect(describeToolStep('Bash', { command: 'ls -la\nmore' }, 'done').title).toBe('Ran ls -la');
    expect(describeToolStep('Bash', { command: 'ls' }, 'error').title).toBe('Failed to run ls');
  });

  it('names MCP tools by tool, with the server as a badge', () => {
    expect(describeToolStep('mcp__omnifex-brain__brain_search', {}, 'done')).toEqual({ title: 'brain_search', badges: ['omnifex-brain'] });
  });

  it('describes a subagent by its description', () => {
    expect(describeToolStep('Agent', { description: 'Review the diff', subagent_type: 'Explore' }, 'done'))
      .toEqual({ title: 'Review the diff', badges: ['Explore'] });
  });

  it('falls back to the tool name', () => {
    expect(describeToolStep('Mystery', {}, 'done')).toEqual({ title: 'Mystery' });
  });
});

describe('describeToolStep — Claude Design and tool loading', () => {
  it('names the tools a ToolSearch select loaded, without the mcp prefixes', () => {
    expect(describeToolStep('ToolSearch', { query: 'select:mcp__claude-artifacts__list_types,mcp__claude-artifacts__guide,Read' }, 'done'))
      .toEqual({ title: 'Loaded tools', badges: ['list_types, guide, Read'] });
  });

  it('keeps a keyword search as typed', () => {
    expect(describeToolStep('ToolSearch', { query: 'slack send' }, 'done')).toEqual({ title: 'Loaded tools', badges: ['slack send'] });
  });

  it('words the Claude Design calls', () => {
    expect(describeToolStep('mcp__claude-artifacts__guide', { topic: 'design' }, 'done').title).toBe('Read the design guide');
    expect(describeToolStep('mcp__claude-artifacts__list_types', {}, 'done').title).toBe('Listed artifact types');
    expect(describeToolStep('mcp__claude-artifacts__create_from_type', { title: 'Habit Tracker Today' }, 'running').title)
      .toBe('Creating Habit Tracker Today');
    expect(describeToolStep('mcp__claude-artifacts__publish_files', {}, 'done').title).toBe('Published');
    expect(describeToolStep('mcp__claude-artifacts__publish_version', {}, 'error').title).toBe('Failed to publish');
    expect(describeToolStep('mcp__claude-artifacts__list_artifacts', {}, 'done').title).toBe('Listed artifacts');
    expect(describeToolStep('mcp__claude-artifacts__list_files', {}, 'running').title).toBe('Listing files');
    expect(describeToolStep('mcp__claude-artifacts__read_file', { path: 'project/canvas.json' }, 'done').title).toBe('Read canvas.json');
    expect(describeToolStep('mcp__claude-artifacts__read_comments', {}, 'done').title).toBe('Read comments');
    expect(describeToolStep('mcp__claude-artifacts__reply_comment', {}, 'done').title).toBe('Replied to a comment');
    expect(describeToolStep('mcp__claude-artifacts__resolve_comment', {}, 'error').title).toBe('Failed to resolve a comment');
    expect(describeToolStep('mcp__claude-artifacts__db_query', {}, 'done').title).toBe('db query');
  });
});

describe('traceHeader', () => {
  it('counts the steps and gives the time as a description', () => {
    expect(traceHeader({ steps: 5, failed: 0, ms: 32_400 })).toEqual({ title: 'Worked in 5 steps', description: '32s' });
    expect(traceHeader({ steps: 1, failed: 0, ms: 125_000 })).toEqual({ title: 'Worked in 1 step', description: '2m 5s' });
  });

  it('says how many failed', () => {
    expect(traceHeader({ steps: 4, failed: 1, ms: null })).toEqual({ title: 'Worked in 4 steps, 1 failed' });
  });

});

describe('reasoningTitle — shadcn Reasoning wording', () => {
  it('says Thinking while it thinks', () => {
    expect(reasoningTitle({ running: true, ms: 4000 })).toBe('Thinking');
  });

  it('says how long once done, or just Thought when unknown', () => {
    expect(reasoningTitle({ running: false, ms: 5_400 })).toBe('Thought for 5s');
    expect(reasoningTitle({ running: false, ms: 95_000 })).toBe('Thought for 1m 35s');
    expect(reasoningTitle({ running: false, ms: null })).toBe('Thought');
    expect(reasoningTitle({ running: false, ms: 300 })).toBe('Thought');
  });
});

describe('thinkingTokensLabel', () => {
  it('writes the estimate as the classic card did', () => {
    expect(thinkingTokensLabel(608)).toBe('~608 tokens');
    expect(thinkingTokensLabel(1200)).toBe('~1,200 tokens');
    expect(thinkingTokensLabel(1)).toBe('~1 token');
  });
});

describe('stepKind — the icon names the action, not its status', () => {
  it('maps each tool to its kind', () => {
    expect(stepKind('Read', {})).toBe('read');
    expect(stepKind('Edit', {})).toBe('edit');
    expect(stepKind('MultiEdit', {})).toBe('edit');
    expect(stepKind('NotebookEdit', {})).toBe('edit');
    expect(stepKind('Write', {})).toBe('create');
    expect(stepKind('Grep', {})).toBe('search');
    expect(stepKind('Glob', {})).toBe('explore');
    expect(stepKind('WebSearch', {})).toBe('web');
    expect(stepKind('WebFetch', {})).toBe('web');
    expect(stepKind('Agent', {})).toBe('agent');
    expect(stepKind('Task', {})).toBe('agent');
    expect(stepKind('TodoWrite', {})).toBe('tasks');
    expect(stepKind('TaskCreate', {})).toBe('tasks');
    expect(stepKind('AskUserQuestion', {})).toBe('question');
    expect(stepKind('Skill', {})).toBe('skill');
    expect(stepKind('mcp__omnifex__progress', {})).toBe('mcp');
    expect(stepKind('Whatever', {})).toBe('tool');
  });

  it('gives each Claude Design call the kind it resembles', () => {
    const A = (t: string) => `mcp__claude-artifacts__${t}`;
    const kinds: [string, string][] = [
      [A('guide'), 'read'], [A('describe_type'), 'read'], [A('read_artifact'), 'read'], [A('read_file'), 'read'],
      [A('list_types'), 'explore'], [A('list_artifacts'), 'explore'], [A('list_files'), 'explore'], [A('list_assets'), 'explore'],
      [A('create_from_type'), 'create'],
      [A('publish_files'), 'design'], [A('publish_version'), 'design'], [A('edit_version'), 'design'],
      [A('read_comments'), 'question'], [A('reply_comment'), 'question'], [A('reply_shared_comment'), 'question'], [A('resolve_comment'), 'question'],
      [A('db_query'), 'mcp'], [A('watch'), 'mcp'],
      ['Artifact', 'design'], ['ArtifactComments', 'question'], ['ArtifactData', 'mcp'],
    ];
    for (const [name, kind] of kinds) expect(stepKind(name, {}), name).toBe(kind);
    expect(stepKind('mcp__other__publish_version', {})).toBe('mcp');
  });

  it('tells commits and new branches apart from other commands', () => {
    expect(stepKind('Bash', { command: 'npm test' })).toBe('command');
    expect(stepKind('Bash', { command: 'git add -A && git commit -m "x"' })).toBe('commit');
    expect(stepKind('Bash', { command: 'git checkout -b feat/x' })).toBe('branch');
    expect(stepKind('Bash', { command: 'git switch -c feat/x' })).toBe('branch');
    expect(stepKind('Bash', { command: 'git log --oneline' })).toBe('command');
  });
});

describe('webSources', () => {
  it('lists the page a fetch read', () => {
    expect(webSources('WebFetch', { url: 'https://ui.shadcn.com/docs/x' }, 'anything'))
      .toEqual([{ title: 'ui.shadcn.com', url: 'https://ui.shadcn.com/docs/x' }]);
  });

  it('lists the links a search returned, across sections', () => {
    const text = 'Web search results for query: "pnpm"\n\nLinks: [{"title":"pnpm install","url":"https://pnpm.io/cli/install"}]\n\nLinks: [{"title":"CI","url":"https://pnpm.io/ci"}]\nsummary';
    expect(webSources('WebSearch', { query: 'pnpm' }, text)).toEqual([
      { title: 'pnpm install', url: 'https://pnpm.io/cli/install' },
      { title: 'CI', url: 'https://pnpm.io/ci' },
    ]);
  });

  it('is empty for unparseable results and other tools', () => {
    expect(webSources('WebSearch', {}, 'Links: [not json]')).toEqual([]);
    expect(webSources('Bash', { command: 'ls' }, 'x')).toEqual([]);
  });
});
