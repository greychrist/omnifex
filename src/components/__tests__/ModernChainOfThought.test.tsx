// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import type { WorkEntry } from '@/lib/modernGrouping';

vi.mock('@/hooks/useLayoutMode', () => ({ useLayoutMode: () => ({ touch: false }) }));
// The diff and markdown read the theme; no ThemeProvider here.
vi.mock('@/hooks', async (orig) => ({
  ...(await orig<typeof import('@/hooks')>()),
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

import { ChainOfThought } from '@/components/transcript-modern/ChainOfThought';

afterEach(() => { cleanup(); });

const ctx = { lookupsFor: () => ({}) as never, tabId: 't' };
const node = (id: string) => ({ kind: 'assistant', raw: { uuid: id } }) as unknown as JsonlNode;

function tool(name: string, input: Record<string, unknown>, resultText?: string, status: 'done' | 'error' | 'pending' = 'done'): WorkEntry {
  return { type: 'tool', key: name + JSON.stringify(input), node: node(name), id: name, name, input, status, resultText, ...(resultText !== undefined ? { resultNode: node(name + '-r') } : {}) } as WorkEntry;
}
const thought: WorkEntry = { type: 'thinking', key: 'th', node: node('th'), text: 'hmm', ms: null, tokens: null };

function open(entries: WorkEntry[]) {
  const r = render(<ChainOfThought entries={entries} nodes={[]} live={false} ctx={ctx} />);
  fireEvent.click(screen.getByRole('button', { name: /Worked in/ }));
  return r;
}

const kindOf = (title: RegExp) =>
  screen.getByText(title).closest('[data-slot="trace-line"]')!.querySelector('[data-step-kind]')!.getAttribute('data-step-kind');

describe('Modern chain of thought — shadcn Trace steps', () => {
  it('gives each step the icon of its action, not a status check', () => {
    open([
      thought,
      tool('Bash', { command: 'npm test' }, 'ok'),
      tool('Read', { file_path: '/a/c.ts' }, 'x'),
      tool('Edit', { file_path: '/a/x.ts', old_string: 'a', new_string: 'b' }, 'ok'),
      tool('Bash', { command: 'git commit -m wip' }, 'ok'),
    ]);
    expect(kindOf(/^Thought/)).toBe('thought');
    expect(kindOf(/^Ran npm test/)).toBe('command');
    expect(kindOf(/^Read c\.ts/)).toBe('read');
    expect(kindOf(/^Edited x\.ts/)).toBe('edit');
    expect(kindOf(/^Ran git commit/)).toBe('commit');
    // The run's header keeps its summary status; no step carries one.
    document.querySelectorAll('[data-step]').forEach((step) => {
      expect(step.querySelector('.lucide-circle-check, .lucide-circle-alert')).toBeNull();
    });
  });

  it('opens a command onto its output alone, with the description as the tooltip', () => {
    open([tool('Bash', { command: 'pnpm --version', description: 'Check pnpm' }, '10.18.0')]);
    const trigger = screen.getByRole('button', { name: /Ran pnpm --version/ });
    expect(trigger).toHaveAttribute('title', 'Check pnpm');
    fireEvent.click(trigger);
    const out = screen.getByText('10.18.0');
    expect(out.closest('[data-step-output]')).toHaveAttribute('data-tone', 'default');
    expect(screen.queryByText('Tool Call')).toBeNull();
    expect(screen.queryByText(/tool-use/)).toBeNull();
  });

  it('draws a failure red and says so in the title', () => {
    open([tool('Bash', { command: 'pnpm install --frozen-lockfile' }, 'ERR_PNPM_OUTDATED_LOCKFILE', 'error')]);
    const trigger = screen.getByRole('button', { name: /Failed to run pnpm install/ });
    expect(trigger.querySelector('[data-slot="trace-line"]')).toHaveAttribute('data-status', 'error');
    fireEvent.click(trigger);
    expect(screen.getByText('ERR_PNPM_OUTDATED_LOCKFILE').closest('[data-step-output]')).toHaveAttribute('data-tone', 'error');
  });

  it('a read has nothing to open: its title says what was read', () => {
    open([tool('Read', { file_path: '/a/c.ts' }, '1\tconst x = 1')]);
    expect(screen.queryByRole('button', { name: /Read c\.ts/ })).toBeNull();
    expect(screen.getByText('Read c.ts')).toBeInTheDocument();
  });

  it('opens an edit onto its diff', () => {
    open([tool('Edit', { file_path: '/a/x.ts', old_string: 'const oldName = 1', new_string: 'const newName = 1' }, 'ok')]);
    fireEvent.click(screen.getByRole('button', { name: /Edited x\.ts/ }));
    expect(screen.getAllByText(/oldName/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/newName/).length).toBeGreaterThan(0);
  });

  it('opens a web search onto the sources it used, as links', () => {
    const text = 'Links: [{"title":"pnpm install","url":"https://pnpm.io/cli/install"}]';
    open([tool('WebSearch', { query: 'pnpm' }, text)]);
    fireEvent.click(screen.getByRole('button', { name: /Searched the web/ }));
    expect(screen.getByRole('link', { name: /pnpm install/ })).toHaveAttribute('href', 'https://pnpm.io/cli/install');
  });

  it('opens a subagent onto its reply', () => {
    open([tool('Agent', { description: 'Review the diff' }, 'Looks good.')]);
    fireEvent.click(screen.getByRole('button', { name: /Review the diff/ }));
    expect(screen.getByText('Looks good.')).toBeInTheDocument();
  });

  it('keeps copy and raw JSON on every step, read included', () => {
    open([tool('Read', { file_path: '/a/c.ts' }, 'x'), tool('Bash', { command: 'ls' }, 'a')]);
    const steps = document.querySelectorAll('[data-step]');
    expect(steps).toHaveLength(2);
    steps.forEach((s) => {
      expect(within(s as HTMLElement).getByRole('button', { name: /Copy/ })).toBeInTheDocument();
      expect(within(s as HTMLElement).getByRole('button', { name: /raw JSON/i })).toBeInTheDocument();
    });
  });

  it('sets an opened thought brighter than the muted step chrome', () => {
    open([thought, tool('Bash', { command: 'npm test' }, 'ok')]);
    fireEvent.click(screen.getByRole('button', { name: /^Thought/ }));
    const body = screen.getByText('hmm');
    expect(body).not.toHaveClass('text-muted-foreground');
    expect(body.className).toMatch(/text-foreground/);
  });

  it('opens a Skill step onto the skill body, in the skill card colours and corner radius', () => {
    const skill = { ...tool('Skill', { skill: 'omnifex-release' }, 'Launching skill: omnifex-release'), skillBody: 'Base directory for this skill: /x\n\n# OmniFex Release\n\nShip it.' } as WorkEntry;
    open([skill]);
    fireEvent.click(screen.getByRole('button', { name: /Used omnifex-release/ }));
    expect(screen.queryByText('Launching skill: omnifex-release')).toBeNull();
    const box = screen.getByText('Ship it.').closest('[data-skill-body]') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.style.borderRadius).toBe('12px');
    expect(box.style.borderColor).not.toBe('');
    expect(within(box).getByText('Skill: OmniFex Release')).toBeInTheDocument();
  });

  it('sets step icons in a bordered chip, brighter than the muted step titles', () => {
    open([thought, tool('Bash', { command: 'npm test' }, 'ok')]);
    document.querySelectorAll('[data-step-kind]').forEach((icon) => {
      expect(icon.className).toMatch(/text-foreground\/85/);
      expect(icon).toHaveClass('border', 'rounded-md');
    });
    expect(document.querySelectorAll('[data-step-kind]').length).toBe(2);
  });

  it('lets a failed step turn its icon chip red, over the brighter default', () => {
    open([tool('Grep', { pattern: 'x' }, 'No such file or directory', 'error')]);
    const icon = document.querySelector('[data-step-kind]')!;
    expect(icon.closest('[data-status="error"]')).not.toBeNull();
    expect(icon.className).toMatch(/in-data-\[status=error\]:text-destructive/);
    // Its border is red via `.modern-step-icon` in styles.css: border-colour
    // utilities lose to the unlayered `* { border-color }` reset.
    expect(icon).toHaveClass('modern-step-icon');
  });

  it('stays open when the run finishes if you opened a step inside it while it was live', () => {
    const entries = [{ ...thought, text: 'reasoning here' }, tool('Bash', { command: 'npm test' }, 'ok')];
    const r = render(<ChainOfThought entries={entries} nodes={[]} live ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: /^Thought/ }));
    expect(screen.getByText('reasoning here')).toBeVisible();
    r.rerender(<ChainOfThought entries={entries} nodes={[]} live={false} ctx={ctx} />);
    expect(screen.getByRole('button', { name: /Worked in/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('reasoning here')).toBeVisible();
  });

  it('still closes a finished run nobody touched', () => {
    const entries = [thought, tool('Bash', { command: 'npm test' }, 'ok')];
    const r = render(<ChainOfThought entries={entries} nodes={[]} live ctx={ctx} />);
    r.rerender(<ChainOfThought entries={entries} nodes={[]} live={false} ctx={ctx} />);
    expect(screen.getByRole('button', { name: /Worked in/ })).toHaveAttribute('aria-expanded', 'false');
  });
});
