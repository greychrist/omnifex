// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NewSessionForm, type NewSessionFormAccountResolution } from '../NewSessionForm';
import type { AgentKind } from '@/lib/api';
import type { EffortLevel, ThinkingConfig } from '../ControlBar';
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

const RESOLUTION: NewSessionFormAccountResolution = {
  account: {
    name: 'Personal',
    account_type: 'pro',
    config_dir: '/Users/me/.claude-personal',
  },
  match_type: 'path_rule',
  match_detail: '/Users/me/Repos',
};

/**
 * Mounts the form with stateful agent + setAgent so user-interaction
 * tests can flip the picker and observe the form rerender. Other props
 * are stubbed to constants since the tests below only assert on the
 * agent/account interaction.
 */
function Harness({ initialAgent = 'claude' as AgentKind, resolution = RESOLUTION as NewSessionFormAccountResolution | null }) {
  const [agent, setAgent] = useState<AgentKind>(initialAgent);
  const [model, setModel] = useState('opus[1m]');
  const [effort, setEffort] = useState<EffortLevel>('high');
  const [thinking, setThinking] = useState<ThinkingConfig>('adaptive');
  const [perm, setPerm] = useState('acceptEdits');
  const [mode, setMode] = useState<SessionMode>('rich');
  return (
    <NewSessionForm
      accountResolution={resolution}
      selectedModel={model}
      setSelectedModel={setModel}
      effort={effort}
      setEffort={setEffort}
      thinkingConfig={thinking}
      setThinkingConfig={setThinking}
      permissionMode={perm}
      setPermissionMode={setPerm}
      sessionStartMode={mode}
      setSessionStartMode={setMode}
      agent={agent}
      setAgent={setAgent}
      onStart={() => {}}
      onChangeAccount={() => {}}
    />
  );
}

describe('NewSessionForm — agent picker', () => {
  it('renders the AgentPicker with Claude selected and shows the Account cell', () => {
    render(<Harness />);
    // Picker renders both options
    expect(screen.getByRole('radio', { name: 'Claude' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Codex' }).getAttribute('aria-checked')).toBe('false');
    // Account label + badge are visible on the Claude path
    expect(screen.getByText('Account')).toBeTruthy();
    expect(screen.getByText('Personal')).toBeTruthy();
  });

  it('hides the Claude account selector and shows the Codex indicator when Codex is picked', () => {
    render(<Harness />);
    // Initially Claude — Account cell is present
    expect(screen.queryByText('Account')).not.toBeNull();
    expect(screen.queryByText('Personal')).not.toBeNull();
    // Flip to Codex
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(screen.getByRole('radio', { name: 'Codex' }).getAttribute('aria-checked')).toBe('true');
    // Account cell gone; Agent/Codex indicator shown instead
    expect(screen.queryByText('Account')).toBeNull();
    expect(screen.queryByText('Personal')).toBeNull();
    // The compact Codex indicator pill — pick the non-radio "Codex" text node
    // (the radio is also "Codex" labeled). At least one such node must remain.
    const codexLabels = screen.getAllByText('Codex');
    expect(codexLabels.length).toBeGreaterThanOrEqual(1);
    // And the "Agent" label is what the indicator cell uses, not "Account"
    expect(screen.getByText('Agent')).toBeTruthy();
  });

  it('flipping back to Claude re-shows the Account selector', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(screen.queryByText('Personal')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Claude' }));
    expect(screen.getByText('Account')).toBeTruthy();
    expect(screen.getByText('Personal')).toBeTruthy();
  });

  it('shows the Codex indicator with no account resolution available', () => {
    // accountResolution=null + agent=codex — only the Codex indicator should
    // render in the leftmost column (no Account cell at all).
    render(<Harness initialAgent="codex" resolution={null} />);
    expect(screen.queryByText('Account')).toBeNull();
    expect(screen.getByText('Agent')).toBeTruthy();
  });
});
