// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { PermissionDeniedCard } from '../PermissionDeniedCard';
import { SessionActionsProvider, type SessionActions } from '@/contexts/SessionActionsContext';

function actions(over: Partial<SessionActions> = {}): SessionActions {
  return {
    projectPath: '/Users/greg/Repos/omnifex',
    homeDir: '/Users/greg',
    permissionMode: 'auto',
    turnRunning: false,
    sendPrompt: vi.fn(),
    addAllowRule: vi.fn(async () => {}),
    setPermissionMode: vi.fn(),
    ...over,
  };
}

function renderCard(a: SessionActions | null, props: Partial<React.ComponentProps<typeof PermissionDeniedCard>> = {}) {
  return render(
    <SessionActionsProvider value={a}>
      <PermissionDeniedCard
        toolName="Bash"
        input={{ command: 'git add -A' }}
        denial={{ kind: 'classifier-block', category: 'Modify Shared Resources' }}
        {...props}
      />
    </SessionActionsProvider>,
  );
}

afterEach(cleanup);

describe('PermissionDeniedCard', () => {
  it('says what was blocked and why', () => {
    renderCard(actions());
    expect(screen.getByText(/Auto mode blocked this/)).toBeTruthy();
    expect(screen.getByText('Modify Shared Resources')).toBeTruthy();
    expect(screen.getByText('`git add -A`', { exact: false })).toBeTruthy();
  });

  it('Approve & retry sends the consent prompt, once per turn', () => {
    const a = actions({ turnRunning: true });
    renderCard(a);
    fireEvent.click(screen.getByRole('button', { name: /Approve & retry/ }));
    expect(a.sendPrompt).toHaveBeenCalledWith('I approve this action — go ahead and retry it: `git add -A`');
    expect((screen.getByRole('button', { name: /Approve & retry/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  // A Stop ends the turn the retry was waiting on; the card must not stay
  // dead, or the only way to re-approve is typing consent by hand.
  it('re-enables Approve & retry once the session stops working', () => {
    const a = actions({ turnRunning: true });
    const { rerender } = renderCard(a);
    fireEvent.click(screen.getByRole('button', { name: /Approve & retry/ }));
    rerender(
      <SessionActionsProvider value={{ ...a, turnRunning: false }}>
        <PermissionDeniedCard
          toolName="Bash"
          input={{ command: 'git add -A' }}
          denial={{ kind: 'classifier-block', category: 'Modify Shared Resources' }}
        />
      </SessionActionsProvider>,
    );
    const button = screen.getByRole('button', { name: /Approve & retry/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(a.sendPrompt).toHaveBeenCalledTimes(2);
  });

  it('Always allow saves the edited rule, then retries', async () => {
    const a = actions();
    renderCard(a);
    fireEvent.click(screen.getByRole('button', { name: /Always allow/ }));
    const field = screen.getByLabelText('Allow rule') as HTMLInputElement;
    expect(field.value).toBe('Bash(git add:*)');
    fireEvent.change(field, { target: { value: 'Bash(git add -A)' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & retry/ }));
    await waitFor(() => expect(a.sendPrompt).toHaveBeenCalled());
    expect(a.addAllowRule).toHaveBeenCalledWith('Bash(git add -A)');
    expect(a.sendPrompt).toHaveBeenCalledWith('I added an allow rule for this — please retry it: `git add -A`');
  });

  it('shows the save error and sends nothing when the rule cannot be written', async () => {
    const a = actions({ addAllowRule: vi.fn(async () => { throw new Error('EACCES'); }) });
    renderCard(a);
    fireEvent.click(screen.getByRole('button', { name: /Always allow/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save & retry/ }));
    await waitFor(() => expect(screen.getByText(/EACCES/)).toBeTruthy());
    expect(a.sendPrompt).not.toHaveBeenCalled();
  });

  it('offers to leave auto mode, and hides that once the session has', () => {
    const a = actions();
    const { rerender } = renderCard(a);
    fireEvent.click(screen.getByRole('button', { name: /Ask me instead/ }));
    expect(a.setPermissionMode).toHaveBeenCalledWith('default');
    rerender(
      <SessionActionsProvider value={{ ...a, permissionMode: 'default' }}>
        <PermissionDeniedCard toolName="Bash" input={{ command: 'git add -A' }} denial={{ kind: 'classifier-block', category: null }} />
      </SessionActionsProvider>,
    );
    expect(screen.queryByRole('button', { name: /Ask me instead/ })).toBeNull();
  });

  // An outage is not a judgement: nothing to approve, nothing to allow.
  it('offers a plain retry when the classifier was unavailable', () => {
    const a = actions();
    renderCard(a, { toolName: 'Edit', input: { file_path: '/a/b.ts' }, denial: { kind: 'classifier-unavailable', category: null } });
    expect(screen.getByText(/safety check was unavailable/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Retry/ }));
    expect(a.sendPrompt).toHaveBeenCalledWith('The auto-mode safety check was unavailable. Please retry: Edit `/a/b.ts`');
  });

  it('notes a subagent denial, whose retry has to go through the main thread', () => {
    renderCard(actions(), { fromSubagent: true });
    expect(screen.getByText(/in a subagent/)).toBeTruthy();
  });

  it('renders without actions outside a live session', () => {
    renderCard(null);
    expect(screen.getByText(/Auto mode blocked this/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
