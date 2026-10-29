// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { PermissionRequestPayload } from '@/lib/types/permissionRequest';

vi.mock('@/hooks/useLayoutMode', () => ({ useLayoutMode: () => ({ touch: false }) }));
vi.mock('@/components/PermissionCard', async (orig) => {
  const real = await orig<typeof import('@/components/PermissionCard')>();
  return { ...real, PermissionCard: () => <div data-classic-card /> };
});

import { ModernQuestionCard } from '@/components/transcript-modern/ModernQuestion';
import { ModernPermissionCard } from '@/components/transcript-modern/ModernPermissionCard';
import { accentStyleFor } from '@/lib/accentStyle';
import { createDefaultConfig } from '@/lib/messageRenderingConfig';

afterEach(() => { cleanup(); });

const questions = [{ question: 'Which DB?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }];
const ask: PermissionRequestPayload = { requestId: 'r', toolName: 'AskUserQuestion', toolInput: { questions }, suggestions: [] };

describe('ModernQuestionCard', () => {
  it('sends the picked option in the shape the CLI documents', () => {
    const onSubmit = vi.fn();
    render(<ModernQuestionCard request={ask} onSubmit={onSubmit} onCancel={() => {}} />);
    const send = screen.getByRole('button', { name: 'Send answer' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Postgres/ }));
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledWith({ questions, answers: { 'Which DB?': 'Postgres' } });
  });

  it('typing an answer picks Other and notes it', () => {
    const onSubmit = vi.fn();
    render(<ModernQuestionCard request={ask} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Other answer to: Which DB?'), { target: { value: 'MySQL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(onSubmit).toHaveBeenCalledWith({
      questions,
      answers: { 'Which DB?': 'MySQL' },
      annotations: { 'Which DB?': { notes: 'User selected Other: "MySQL"' } },
    });
  });

  it('Dismiss cancels', () => {
    const onCancel = vi.fn();
    render(<ModernQuestionCard request={ask} onSubmit={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('ModernQuestionCard — the classic card\'s look', () => {
  it('takes the question accent colour and the inset margin', () => {
    const { container } = render(<ModernQuestionCard request={ask} onSubmit={() => {}} onCancel={() => {}} />);
    const card = container.firstElementChild as HTMLElement;
    const accent = accentStyleFor(createDefaultConfig(), 'permission.askUserQuestion');
    expect(accent?.backgroundColor).toBeTruthy();
    // jsdom normalises hex to rgb(a), so compare through a styled probe.
    const probe = document.createElement('div');
    probe.style.backgroundColor = String(accent?.backgroundColor);
    probe.style.borderColor = String(accent?.borderColor);
    expect(card.style.backgroundColor).toBe(probe.style.backgroundColor);
    expect(card.style.borderColor).toBe(probe.style.borderColor);
    expect(card.className).toMatch(/\bmx-2\b/);
    expect(card.className).toMatch(/\bmy-2\b/);
  });
});

const bash: PermissionRequestPayload = {
  requestId: 'p', toolName: 'Bash', toolInput: { command: 'npm run package' },
  suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm run package' }] }] as never,
};

describe('ModernPermissionCard', () => {
  it('shows the command and allows once with no rule', () => {
    const onAllow = vi.fn();
    render(<ModernPermissionCard request={bash} onAllow={onAllow} onDeny={() => {}} />);
    expect(screen.getByText('npm run package', { selector: 'pre' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(onAllow).toHaveBeenCalledWith([]);
  });

  it('saves the suggested rule where the user chose', () => {
    const onAllow = vi.fn();
    render(<ModernPermissionCard request={bash} onAllow={onAllow} onDeny={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Me, Everywhere' }));
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    const [suggestion] = onAllow.mock.calls[0][0] as { destination: string; rules: { toolName: string; ruleContent?: string }[] }[];
    expect(suggestion.destination).toBe('userSettings');
    expect(suggestion.rules[0]).toMatchObject({ toolName: 'Bash', ruleContent: 'npm run package' });
  });

  it('denies', () => {
    const onDeny = vi.fn();
    render(<ModernPermissionCard request={bash} onAllow={() => {}} onDeny={onDeny} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onDeny).toHaveBeenCalled();
  });

  it('keeps the classic card for Codex approvals', () => {
    const { container } = render(
      <ModernPermissionCard request={{ ...bash, kind: 'exec' }} onAllow={() => {}} onDeny={() => {}} />,
    );
    expect(container.querySelector('[data-classic-card]')).not.toBeNull();
  });
});

describe('Modern live cards — typeface', () => {
  it('set both cards in Geist', () => {
    const q = render(<ModernQuestionCard request={ask} onSubmit={() => {}} onCancel={() => {}} />);
    expect(q.container.firstElementChild?.className).toContain('modern-format');
    cleanup();
    const p = render(<ModernPermissionCard request={bash} onAllow={() => {}} onDeny={() => {}} />);
    expect(p.container.firstElementChild?.className).toContain('modern-format');
  });
});

describe('ModernQuestionCard — collapse, as the classic card', () => {
  it('folds away to its header so the chat behind it can be read, and opens again', () => {
    render(<ModernQuestionCard request={ask} onSubmit={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse question' }));
    expect(screen.queryByText('Which DB?')).toBeNull();
    expect(screen.queryByRole('button', { name: /Send answer/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand question' }));
    expect(screen.getByText('Which DB?')).toBeInTheDocument();
  });
});
