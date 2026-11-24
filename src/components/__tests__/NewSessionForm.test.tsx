// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NewSessionForm } from '../NewSessionForm';
import type { Account, AgentKind, CodexAuthStatus, ResolvePair, ResolveSlot } from '@/lib/api';
import type { EffortLevel } from '../ControlBar';

vi.mock('@/contexts/AccountsContext', () => ({
  useAccounts: () => ({
    accounts: [],
    refresh: async () => {},
    getColor: () => null,
    getIcon: () => null,
    getAccountType: () => null,
  }),
}));

vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray' as const, setTheme: async () => {} }),
}));

// Resolves empty so the picker uses FALLBACK_MODELS.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listSupportedModels: vi.fn(async () => []),
      getClaudeSettings: vi.fn(async () => ({})),
    },
  };
});

afterEach(() => { cleanup(); });

function makeAccount(over: Partial<Account> & Pick<Account, 'name' | 'engine'>): Account {
  return {
    id: 1,
    config_dir: `/cfg/${over.name}`,
    subscription_label: 'pro',
    has_cost: false,
    color: null,
    icon: null,
    cli_path: null,
    expected_email: null,
    created_at: '',
    updated_at: '',
    ...over,
  };
}

function makeSlot(name: string, engine: AgentKind): ResolveSlot {
  return {
    account: makeAccount({ name, engine }),
    matchType: 'path_rule',
    matchDetail: '/Users/me/Repos',
  };
}

// Claude routes to "Personal", Codex routes to "Codex Work" — used to assert
// the AgentPicker flip swaps the displayed account between slots.
const PAIR: ResolvePair = {
  claude: makeSlot('Personal', 'claude'),
  codex: makeSlot('Codex Work', 'codex'),
};

function Harness({
  initialAgent = 'claude',
  pair = PAIR,
  codexAuthStatus,
  onCodexSignIn,
  onChooseAccount,
  onStart,
}: {
  initialAgent?: AgentKind;
  pair?: ResolvePair;
  codexAuthStatus?: CodexAuthStatus | null;
  onCodexSignIn?: () => void;
  onChooseAccount?: () => void;
  onStart?: () => void;
} = {}) {
  const [agent, setAgent] = useState<AgentKind>(initialAgent);
  const [model, setModel] = useState('sonnet');
  const [effort, setEffort] = useState<EffortLevel>('high');
  const [perm, setPerm] = useState('acceptEdits');
  return (
    <NewSessionForm
      resolvePair={pair}
      selectedModel={model}
      setSelectedModel={setModel}
      effort={effort}
      setEffort={setEffort}
      permissionMode={perm}
      setPermissionMode={setPerm}
      agent={agent}
      setAgent={setAgent}
      onStart={onStart ?? (() => {})}
      onChangeAccount={() => {}}
      onChooseAccount={onChooseAccount}
      codexAuthStatus={codexAuthStatus}
      onCodexSignIn={onCodexSignIn}
    />
  );
}

describe('NewSessionForm — model picker', () => {
  it('lists the fallback catalog (incl. Fable 5 and Default) when no live catalog resolves', async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByTitle('Sonnet'));
    expect(screen.getAllByText('Fable 5').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Account Default').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Haiku').length).toBeGreaterThan(0);
  });

  it('shows the catalog description detail under each model name', async () => {
    const { api } = await import('@/lib/api');
    vi.mocked(api.listSupportedModels).mockResolvedValue([
      {
        value: 'default',
        displayName: 'Default (recommended)',
        description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks',
      },
      { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 4.6 · Efficient for routine tasks' },
    ]);
    render(<Harness />);
    fireEvent.click(await screen.findByTitle('Sonnet'));
    expect(screen.getAllByText('Opus 4.8 with 1M context').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Best for everyday/)).toBeNull();
  });

  it('always shows the selected model detail line in the closed trigger', async () => {
    const { api } = await import('@/lib/api');
    vi.mocked(api.listSupportedModels).mockResolvedValue([
      { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 4.6 · Efficient for routine tasks' },
    ]);
    render(<Harness />);
    expect(await screen.findByText('Sonnet 4.6')).toBeTruthy();
  });
});

describe('NewSessionForm — agent picker', () => {
  it('renders the AgentPicker with Claude selected and shows the Claude slot account', () => {
    render(<Harness />);
    expect(screen.getByRole('radio', { name: 'Claude' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Codex' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Account')).toBeTruthy();
    expect(screen.getByText('Personal')).toBeTruthy();
    expect(screen.queryByText('Codex Work')).toBeNull();
  });

  it('flipping the AgentPicker to Codex swaps the displayed account to the codex slot', () => {
    render(<Harness />);
    expect(screen.queryByText('Personal')).not.toBeNull();
    expect(screen.queryByText('Codex Work')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(screen.getByRole('radio', { name: 'Codex' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Account')).toBeTruthy();
    expect(screen.getByText('Codex Work')).toBeTruthy();
    expect(screen.queryByText('Personal')).toBeNull();
  });

  it('flipping back to Claude re-shows the Claude slot account', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(screen.queryByText('Personal')).toBeNull();
    expect(screen.getByText('Codex Work')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Claude' }));
    expect(screen.getByText('Account')).toBeTruthy();
    expect(screen.getByText('Personal')).toBeTruthy();
    expect(screen.queryByText('Codex Work')).toBeNull();
  });

  it('shows a "Choose account" button when the active engine slot is null', () => {
    const onChooseAccount = vi.fn();
    render(
      <Harness
        initialAgent="codex"
        pair={{ claude: makeSlot('Personal', 'claude'), codex: null }}
        codexAuthStatus={{ authenticated: true, mode: 'oauth' }}
        onChooseAccount={onChooseAccount}
      />,
    );
    const choose = screen.getByRole('button', { name: /choose account/i });
    expect(choose).toBeTruthy();
    expect(screen.queryByText('Codex Work')).toBeNull();
    fireEvent.click(choose);
    expect(onChooseAccount).toHaveBeenCalledTimes(1);
  });
});

describe('NewSessionForm — Codex auth banner', () => {
  it('renders banner + disables submit when codex agent is unauthenticated', () => {
    const onStart = vi.fn();
    render(
      <Harness
        initialAgent="codex"
        codexAuthStatus={{ authenticated: false }}
        onCodexSignIn={() => {}}
        onStart={onStart}
      />,
    );
    const banner = screen.getByTestId('codex-auth-banner');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('You need to sign in to Codex');
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: /Start Session/ });
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('hides banner + enables submit when codex agent is authenticated', () => {
    const onStart = vi.fn();
    render(
      <Harness
        initialAgent="codex"
        codexAuthStatus={{ authenticated: true, mode: 'oauth', email: 'x@y.com' }}
        onCodexSignIn={() => {}}
        onStart={onStart}
      />,
    );
    expect(screen.queryByTestId('codex-auth-banner')).toBeNull();
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: /Start Session/ });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('treats null auth status as unauthenticated (loading state)', () => {
    render(
      <Harness
        initialAgent="codex"
        codexAuthStatus={null}
        onCodexSignIn={() => {}}
      />,
    );
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: /Start Session/ });
    expect(submit.disabled).toBe(true);
    expect(screen.queryByTestId('codex-auth-banner')).toBeTruthy();
  });

  it('clicking the inline Sign in button calls onCodexSignIn', () => {
    const onCodexSignIn = vi.fn();
    render(
      <Harness
        initialAgent="codex"
        codexAuthStatus={{ authenticated: false }}
        onCodexSignIn={onCodexSignIn}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));
    expect(onCodexSignIn).toHaveBeenCalledTimes(1);
  });

  it('does NOT gate the submit button on the Claude agent path even with no codex auth status', () => {
    const onStart = vi.fn();
    render(
      <Harness
        initialAgent="claude"
        codexAuthStatus={null}
        onStart={onStart}
      />,
    );
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: /Start Session/ });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('codex-auth-banner')).toBeNull();
  });
});

