import { describe, it, expect } from 'vitest';
import { describeToolStep, reasoningTitle, thinkingTokensLabel, traceHeader } from '../modernSteps';

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

  it('keeps a command\'s own description, and falls back to the command', () => {
    expect(describeToolStep('Bash', { command: 'npm test', description: 'Run the tests' }, 'done').title).toBe('Run the tests');
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
