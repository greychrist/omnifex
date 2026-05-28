// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NewSessionForm } from '../NewSessionForm';
import type { Account, AgentKind, CodexAuthStatus, ResolvePair, ResolveSlot } from '@/lib/api';
import type { EffortLevel } from '../ControlBar';
import type { SessionMode } from '@/lib/api';

// AccountBadge consumes useAccounts() + useTheme(). Stub both so the
// form renders without a real provider tree.
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

afterEach(() => { cleanup(); });

/** Minimal valid Account for a slot. Only `name` is displayed by the form. */
function makeAccount(over: Partial<Account> & Pick<Account, 'name' | 'engine'>): Account {
  return {
    id: 1,
    config_dir: `/cfg/${over.name}`,
    subscription_label: 'pro',
    has_cost: false,
    color: null,
    icon: null,
    cli_path: null,
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

/**
 * Mounts the form with stateful agent + setAgent so user-interaction
 * tests can flip the picker and observe the form rerender. Other props
 * are stubbed to constants since the tests below only assert on the
 * agent/account interaction.
 */
function Harness({
  initialAgent = 'claude' as AgentKind,
  pair = PAIR as ResolvePair,
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
  const [model, setModel] = useState('opus');
  const [effort, setEffort] = useState<EffortLevel>('high');
  const [perm, setPerm] = useState('acceptEdits');
  const [mode, setMode] = useState<SessionMode>('rich');
  return (
    <NewSessionForm
      resolvePair={pair}
      selectedModel={model}
      setSelectedModel={setModel}
      effort={effort}
      setEffort={setEffort}
      permissionMode={perm}
      setPermissionMode={setPerm}
      sessionStartMode={mode}
      setSessionStartMode={setMode}
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

describe('NewSessionForm — agent picker', () => {
  it('renders the AgentPicker with Claude selected and shows the Claude slot account', () => {
    render(<Harness />);
    // Picker renders both options
    expect(screen.getByRole('radio', { name: 'Claude' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Codex' }).getAttribute('aria-checked')).toBe('false');
    // Account label + the Claude slot's account badge are visible
    expect(screen.getByText('Account')).toBeTruthy();
    expect(screen.getByText('Personal')).toBeTruthy();
    expect(screen.queryByText('Codex Work')).toBeNull();
  });

  it('flipping the AgentPicker to Codex swaps the displayed account to the codex slot', () => {
    render(<Harness />);
    // Initially Claude — Personal shown, Codex Work not.
    expect(screen.queryByText('Personal')).not.toBeNull();
    expect(screen.queryByText('Codex Work')).toBeNull();
    // Flip to Codex.
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(screen.getByRole('radio', { name: 'Codex' }).getAttribute('aria-checked')).toBe('true');
    // Account cell now shows the codex slot's account; Claude's is gone.
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
    // Codex slot null + agent=codex — the leftmost cell renders the
    // "Choose account" affordance instead of an account badge.
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
    // Banner present.
    const banner = screen.getByTestId('codex-auth-banner');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('You need to sign in to Codex');
    // Submit button disabled.
    const submit = screen.getByRole('button', { name: /Start Session/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // Clicking the disabled submit does nothing.
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
    const submit = screen.getByRole('button', { name: /Start Session/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('treats null auth status as unauthenticated (loading state)', () => {
    // While useCodexAuthStatus is still resolving the initial snapshot we
    // pass null. Submit should stay disabled until we know.
    render(
      <Harness
        initialAgent="codex"
        codexAuthStatus={null}
        onCodexSignIn={() => {}}
      />,
    );
    const submit = screen.getByRole('button', { name: /Start Session/ }) as HTMLButtonElement;
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
    const submit = screen.getByRole('button', { name: /Start Session/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('codex-auth-banner')).toBeNull();
  });
});

