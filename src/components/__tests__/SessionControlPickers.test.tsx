// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, within, waitFor } from '@testing-library/react';
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
  it('reads model and effort as one readout under the `model` label', () => {
    setup();
    expect(within(item('model')).getByText('model')).toBeTruthy();
    expect(within(item('model')).getByText('Sonnet')).toBeTruthy();
    // Effort rides along in the same control, as `Sonnet High`.
    expect(within(item('model')).getByText('High')).toBeTruthy();
    expect(screen.queryByTestId('control-effort')).toBeNull();
    expect(within(item('perms')).getByText('perms')).toBeTruthy();
    expect(within(item('perms')).getByText('Accept Edits')).toBeTruthy();
  });

  it('leads each readout with a glyph, like the rest of the bar', () => {
    setup();
    expect(item('model').querySelector('svg.lucide-zap')).toBeTruthy();
    // One glyph that means "permissions", whatever the mode — not the
    // mode's own, which would change under you and collide with Default's.
    for (const permissionMode of ['acceptEdits', 'plan', 'default', 'auto']) {
      cleanup();
      setup({ permissionMode });
      expect(item('perms').querySelectorAll('svg')).toHaveLength(1);
      expect(item('perms').querySelector('svg.lucide-shield-check')).toBeTruthy();
    }
  });

  it('tints the whole perms readout — glyph, label and value — in the mode color', () => {
    setup({ permissionMode: 'auto' });
    const button = within(item('perms')).getByRole('button');
    expect(button.className).toContain('text-yellow-600');
    for (const el of button.querySelectorAll('[class*="text-"]')) {
      expect(el.getAttribute('class')).not.toMatch(/text-(purple|muted|foreground)/);
    }
  });

  it('gives the Codex readouts glyphs too', () => {
    setup({ engine: 'codex', model: 'gpt-5', effort: 'medium', permissionMode: 'default' });
    expect(item('model').querySelector('svg')).toBeTruthy();
    expect(item('effort').querySelector('svg')).toBeTruthy();
    expect(item('perms').querySelector('svg')).toBeTruthy();
  });

  it('separates the two with the same hairline the readouts use', () => {
    setup();
    expect(screen.getAllByTestId('status-divider')).toHaveLength(1);
  });

  it('reaches effort through the model dropdown', () => {
    const { setEffort } = setup();
    fireEvent.click(within(item('model')).getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: /effort/i }));
    fireEvent.click(screen.getByText('Low'));
    expect(setEffort).toHaveBeenCalledWith('low');
  });

  it('offers the models the account catalog leaves out', () => {
    const { setModel } = setup();
    fireEvent.click(within(item('model')).getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: /more models/i }));
    fireEvent.click(screen.getByText('Opus 5.5'));
    expect(setModel).toHaveBeenCalledWith('claude-opus-5-5');
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

  it('names the model readout after the model that actually ran', async () => {
    // The CLI advertises `claude-opus-5[1m]` as "Opus 5 (1M context)" while
    // the server resolves it to claude-opus-5-5, so the catalog label alone
    // disagreed with the session card's own "opus 5.5" summary.
    const { api } = await import('@/lib/api');
    vi.mocked(api.listSupportedModels).mockResolvedValueOnce([
      { value: 'claude-opus-5[1m]', displayName: 'Opus 5 (1M context)', description: 'Best for everyday, complex tasks' },
    ] as never);
    setup({
      model: 'claude-opus-5[1m]',
      configDir: '/cfg',
      activeDefaultModel: 'claude-opus-5-5',
    });
    await waitFor(() => {
      expect(within(item('model')).getByText('Opus 5.5')).toBeTruthy();
    });
  });

  it('names each readout for assistive tech, value included', () => {
    setup();
    expect(within(item('model')).getByRole('button', { name: /model.*sonnet/i })).toBeTruthy();
    expect(within(item('perms')).getByRole('button', { name: /perms.*accept edits/i })).toBeTruthy();
  });
});
