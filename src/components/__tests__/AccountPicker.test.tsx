// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { AccountPicker, ALL_ACCOUNTS, UNASSIGNED } from '../AccountPicker';

vi.mock('@/contexts/AccountsContext', () => ({
  useAccounts: () => ({
    accounts: [],
    refresh: vi.fn(),
    getColor: (n: string) => (n === 'Work' ? '#3b82f6' : '#a855f7'),
    getIcon: () => null,
    getAccountType: (n: string) => (n === 'Work' ? 'Enterprise' : 'Max'),
  }),
}));

vi.mock('@/hooks', () => ({ useTheme: () => ({ theme: 'gray' }) }));

const NAMES = ['Personal', 'Work'];

describe('AccountPicker — single mode', () => {
  afterEach(cleanup);

  it('renders the selected account as its badge, not as plain text', () => {
    render(<AccountPicker accounts={NAMES} value="Work" onChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox');
    // The badge carries the account's own colour and subscription label —
    // the thing that distinguishes it from a bare <select>.
    expect(within(trigger).getByText('Work')).toBeTruthy();
    expect(within(trigger).getByText(': Enterprise')).toBeTruthy();
  });

  it('shows the placeholder when nothing is selected', () => {
    render(
      <AccountPicker accounts={NAMES} value={null} onChange={vi.fn()} placeholder="Select an account" />,
    );
    expect(screen.getByText('Select an account')).toBeTruthy();
  });

  it('offers an All option only when allowAll is set', () => {
    const { rerender } = render(
      <AccountPicker accounts={NAMES} value={ALL_ACCOUNTS} onChange={vi.fn()} allowAll />,
    );
    expect(screen.getByRole('combobox').textContent).toContain('All');

    rerender(<AccountPicker accounts={NAMES} value="Work" onChange={vi.fn()} />);
    expect(screen.getByRole('combobox').textContent).not.toContain('All');
  });

  // The Projects list carries a legacy bucket for projects whose account did
  // not resolve. It is not an account, so it must not wear an account badge.
  it('renders the unassigned sentinel as muted text, never as a badge', () => {
    render(<AccountPicker accounts={[UNASSIGNED]} value={UNASSIGNED} onChange={vi.fn()} />);
    expect(screen.getByText('No account')).toBeTruthy();
  });
});

describe('AccountPicker — multi mode', () => {
  afterEach(cleanup);

  const open = () => fireEvent.click(screen.getByRole('button'));

  // Empty means "all", matching the query layer: clearing every checkbox must
  // show everything, not nothing.
  it('summarises an empty selection as All', () => {
    render(<AccountPicker mode="multi" accounts={NAMES} selected={[]} onChange={vi.fn()} />);
    expect(screen.getByRole('button').textContent).toContain('All');
  });

  it('renders a single selection as that account badge', () => {
    render(<AccountPicker mode="multi" accounts={NAMES} selected={['Work']} onChange={vi.fn()} />);
    const btn = screen.getByRole('button');
    expect(within(btn).getByText('Work')).toBeTruthy();
  });

  it('counts a multiple selection rather than overflowing the trigger', () => {
    render(<AccountPicker mode="multi" accounts={NAMES} selected={NAMES} onChange={vi.fn()} />);
    expect(screen.getByRole('button').textContent).toContain('2 accounts');
  });

  it('toggles a value on and off', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AccountPicker mode="multi" accounts={NAMES} selected={[]} onChange={onChange} />,
    );
    open();
    fireEvent.click(screen.getByTestId('account-option-Work'));
    expect(onChange).toHaveBeenCalledWith(['Work']);

    onChange.mockClear();
    rerender(<AccountPicker mode="multi" accounts={NAMES} selected={['Work']} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('account-option-Work'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('clears back to all via the All option', () => {
    const onChange = vi.fn();
    render(<AccountPicker mode="multi" accounts={NAMES} selected={NAMES} onChange={onChange} />);
    open();
    fireEvent.click(screen.getByTestId('account-option-all'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('shows each account as a badge in the open list', () => {
    render(<AccountPicker mode="multi" accounts={NAMES} selected={[]} onChange={vi.fn()} />);
    open();
    for (const n of NAMES) {
      expect(within(screen.getByTestId(`account-option-${n}`)).getByText(n)).toBeTruthy();
    }
  });
});

describe('AccountPicker — shared chrome', () => {
  afterEach(cleanup);

  // The whole point of the extraction: both modes must present the same
  // trigger, or they read as two different controls.
  it('gives both modes the same trigger classes', () => {
    const { container: single } = render(
      <AccountPicker accounts={NAMES} value="Work" onChange={vi.fn()} />,
    );
    const singleCls = single.querySelector('[role="combobox"]')!.className;
    cleanup();
    const { container: multi } = render(
      <AccountPicker mode="multi" accounts={NAMES} selected={['Work']} onChange={vi.fn()} />,
    );
    const multiCls = multi.querySelector('button')!.className;
    for (const cls of ['h-7', 'text-xs', 'gap-1.5', 'pl-1']) {
      expect(singleCls, `single missing ${cls}`).toContain(cls);
      expect(multiCls, `multi missing ${cls}`).toContain(cls);
    }
  });
});
