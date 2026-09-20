// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import { SessionControlPickers } from '@/components/SessionControlPickers';
import { ACCOUNT_DEFAULT_MARK } from '@/lib/modelCatalog';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, listSupportedModels: vi.fn(async () => []) } };
});

afterEach(() => { cleanup(); });

function setup(overrides: Partial<React.ComponentProps<typeof SessionControlPickers>> = {}) {
  const setModel = vi.fn();
  const setEffort = vi.fn();
  const setPermissionMode = vi.fn();
  render(
    <SessionControlPickers
      engine="claude"
      model="sonnet"
      setModel={setModel}
      effort="high"
      setEffort={setEffort}
      permissionMode="acceptEdits"
      setPermissionMode={setPermissionMode}
      {...overrides}
    />,
  );
  return { setModel, setEffort, setPermissionMode };
}

const item = (label: string) => screen.getByTestId(`control-${label}`);

describe('SessionControlPickers — status-bar readouts that open pickers', () => {
  it('reads as three `label value` readouts, like the readouts beside them', () => {
    setup();
    expect(within(item('model')).getByText('model')).toBeTruthy();
    expect(within(item('model')).getByText('Sonnet')).toBeTruthy();
    expect(within(item('effort')).getByText('effort')).toBeTruthy();
    expect(within(item('effort')).getByText('High')).toBeTruthy();
    expect(within(item('perms')).getByText('perms')).toBeTruthy();
    expect(within(item('perms')).getByText('Accept Edits')).toBeTruthy();
  });

  it('separates the three with the same hairline the readouts use', () => {
    setup();
    expect(screen.getAllByTestId('status-divider')).toHaveLength(2);
  });

  it('opens the effort menu on click and pushes the pick through', () => {
    const { setEffort } = setup();
    fireEvent.click(within(item('effort')).getByRole('button'));
    fireEvent.click(screen.getByText('Maximum effort (Opus 4.6/4.7 only)'));
    expect(setEffort).toHaveBeenCalledWith('max');
  });

  it('opens the permission menu on click and pushes the pick through', () => {
    const { setPermissionMode } = setup();
    fireEvent.click(within(item('perms')).getByRole('button'));
    fireEvent.click(screen.getByText('Plan'));
    expect(setPermissionMode).toHaveBeenCalledWith('plan');
  });

  it('opens the model menu on click and pushes the pick through', () => {
    const { setModel } = setup();
    fireEvent.click(within(item('model')).getByRole('button'));
    fireEvent.click(screen.getByText('Haiku'));
    expect(setModel).toHaveBeenCalledWith('haiku');
  });

  it('folds the account default into the model it resolves to, marked', () => {
    // The live session reports the concrete model behind "default"; the
    // readout names that model rather than the word "Default".
    setup({ model: 'default', activeDefaultModel: 'claude-fable-5' });
    expect(within(item('model')).getByText(`Fable 5 ${ACCOUNT_DEFAULT_MARK}`)).toBeTruthy();
  });

  it('names each readout for assistive tech, value included', () => {
    setup();
    expect(within(item('effort')).getByRole('button', { name: /effort.*high/i })).toBeTruthy();
  });
});
