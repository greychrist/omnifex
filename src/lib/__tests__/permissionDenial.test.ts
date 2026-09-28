import { describe, it, expect } from 'vitest';
import {
  describeDenial,
  denialFromToolResult,
  suggestDenialRule,
  retryPrompt,
  ruleAddedPrompt,
  findToolUse,
  findToolUseInput,
  toolResultText,
  hasLiveDenial,
} from '../permissionDenial';
import type { JsonlNode } from '@/types/jsonl';

// Wire text captured from CLI 2.1.284 sessions (~/.omnifex/sessions, Sep 2026).
const BLOCK_MESSAGE =
  'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Irreversible Local Destruction]. If you have other tasks that don\'t depend on this action, continue working on those.';
const UNAVAILABLE_MESSAGE =
  'claude-sonnet-5[1m] is temporarily unavailable (timed out), so auto mode cannot determine the safety of Bash right now. Wait a moment and then try this action again.';

describe('describeDenial — the live system/permission_denied event', () => {
  it('reads a classifier policy block and its category', () => {
    expect(describeDenial({
      decisionReasonType: 'classifier',
      decisionReason: '[Irreversible Local Destruction]',
      message: BLOCK_MESSAGE,
    })).toEqual({ kind: 'classifier-block', category: 'Irreversible Local Destruction' });
  });

  // An outage fails closed. It is not a judgement about the action, so the
  // card offers a plain retry rather than asking the user to approve it.
  it('reads a classifier outage as unavailable, not as a refusal', () => {
    expect(describeDenial({
      decisionReasonType: 'classifier',
      decisionReason: 'Classifier unavailable',
      message: UNAVAILABLE_MESSAGE,
    })).toEqual({ kind: 'classifier-unavailable', category: null });
    expect(describeDenial({
      decisionReasonType: 'classifier',
      decisionReason: 'Stage 2 classifier error - blocking based on stage 1 assessment',
      message: '',
    }).kind).toBe('classifier-unavailable');
  });

  it('keeps any other denial (a rule, dontAsk) generic', () => {
    expect(describeDenial({ decisionReasonType: 'rule', decisionReason: 'Bash(rm:*)', message: 'x' }))
      .toEqual({ kind: 'other', category: null });
  });
});

describe('denialFromToolResult — rebuilding the card after a reload', () => {
  // The CLI never writes permission_denied to the JSONL, so a reloaded
  // transcript only has the tool_result the model was handed.
  it('recognises a classifier block', () => {
    expect(denialFromToolResult(BLOCK_MESSAGE))
      .toEqual({ kind: 'classifier-block', category: 'Irreversible Local Destruction' });
  });

  it('recognises a classifier outage', () => {
    expect(denialFromToolResult(UNAVAILABLE_MESSAGE)).toEqual({ kind: 'classifier-unavailable', category: null });
  });

  it('ignores every other tool error', () => {
    expect(denialFromToolResult('Exit code 1\nNo such file or directory')).toBeNull();
    expect(denialFromToolResult('')).toBeNull();
  });
});

describe('suggestDenialRule — the editable "Always allow" rule', () => {
  const project = '/Users/greg/Repos/omnifex';
  const home = '/Users/greg';

  it('grants a Bash command by its command and subcommand, not the whole binary', () => {
    expect(suggestDenialRule('Bash', { command: 'git add -A' }, project, home)).toBe('Bash(git add:*)');
    expect(suggestDenialRule('Bash', { command: 'gh pr review 12 --approve' }, project, home)).toBe('Bash(gh pr:*)');
  });

  it('stops at flags and paths, which are arguments rather than subcommands', () => {
    expect(suggestDenialRule('Bash', { command: 'rm -rf build' }, project, home)).toBe('Bash(rm:*)');
    expect(suggestDenialRule('Bash', { command: 'xcodebuild -scheme OmniFex' }, project, home)).toBe('Bash(xcodebuild:*)');
    expect(suggestDenialRule('Bash', { command: 'cat ./notes.md' }, project, home)).toBe('Bash(cat:*)');
  });

  // Shell operators are rule boundaries (docs/permission-syntax.md), and a
  // leading `cd` is navigation — the command that was judged is after it.
  it('skips a leading cd and grants the command that follows', () => {
    expect(suggestDenialRule('Bash', { command: 'cd ~/Repos/win && git commit -m "x"' }, project, home))
      .toBe('Bash(git commit:*)');
  });

  // Only Edit(path) rules are matched for file tools (CLI >= 2.1.210): a
  // Write(path) rule loads but never matches.
  it('grants a file edit as an Edit rule on its folder, whatever tool wrote it', () => {
    expect(suggestDenialRule('Write', { file_path: '/Users/greg/.claude-personal/settings.json' }, project, home))
      .toBe('Edit(~/.claude-personal/**)');
    expect(suggestDenialRule('Edit', { file_path: '/Users/greg/Repos/omnifex/src/a.ts' }, project, home))
      .toBe('Edit(/src/**)');
    expect(suggestDenialRule('Edit', { file_path: '/opt/data/x.json' }, project, home))
      .toBe('Edit(//opt/data/**)');
  });

  it('grants a fetch by domain and anything else by tool name', () => {
    expect(suggestDenialRule('WebFetch', { url: 'https://example.com/a' }, project, home)).toBe('WebFetch(domain:example.com)');
    expect(suggestDenialRule('mcp__github__create_pr', {}, project, home)).toBe('mcp__github__create_pr');
  });

  it('offers nothing it cannot phrase', () => {
    expect(suggestDenialRule('Bash', {}, project, home)).toBeNull();
  });
});

describe('retryPrompt — what "Approve & retry" sends', () => {
  it('states the approval and names the action', () => {
    expect(retryPrompt('classifier-block', 'Bash', { command: 'rm -rf build' }))
      .toBe('I approve this action — go ahead and retry it: `rm -rf build`');
  });

  it('says a rule now covers it when one was just added', () => {
    expect(ruleAddedPrompt('Bash', { command: 'git add -A' }))
      .toBe('I added an allow rule for this — please retry it: `git add -A`');
  });

  it('asks for a plain retry after an outage', () => {
    expect(retryPrompt('classifier-unavailable', 'Edit', { file_path: '/a/b.ts' }))
      .toBe('The auto-mode safety check was unavailable. Please retry: Edit `/a/b.ts`');
  });
});

describe('transcript lookups', () => {
  const nodes = [
    { kind: 'assistant', sessionId: 's', receivedAt: 't', raw: { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'rm -rf build' } },
    ] } } },
    { kind: 'system', subtype: 'permission_denied', sessionId: 's', receivedAt: 't', raw: { type: 'system', subtype: 'permission_denied', tool_use_id: 'toolu_1' } },
  ] as unknown as JsonlNode[];

  it('finds a tool call by id', () => {
    expect(findToolUse(nodes, 'toolu_1')).toEqual({ name: 'Bash', input: { command: 'rm -rf build' } });
    expect(findToolUse(nodes, 'toolu_x')).toBeNull();
  });

  it('finds a tool call\'s input by id', () => {
    expect(findToolUseInput(nodes, 'toolu_1')).toEqual({ command: 'rm -rf build' });
    expect(findToolUseInput(nodes, 'toolu_x')).toBeNull();
  });

  // Live, the event and the tool_result both arrive; the card renders once,
  // from the event. After a reload only the tool_result is left.
  it('knows when the live event already carries the card', () => {
    expect(hasLiveDenial(nodes, 'toolu_1')).toBe(true);
    expect(hasLiveDenial(nodes, 'toolu_2')).toBe(false);
  });
});

describe('toolResultText', () => {
  it('reads string and text-block content, skipping images', () => {
    expect(toolResultText('plain')).toBe('plain');
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(toolResultText(undefined)).toBe('');
  });
});
