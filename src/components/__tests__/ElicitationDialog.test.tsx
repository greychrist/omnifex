// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ElicitationDialog, type ElicitationRequest } from '../ElicitationDialog';

afterEach(() => { cleanup(); });

const formRequest: ElicitationRequest = {
  requestId: 'e1',
  serverName: 'github',
  displayName: 'GitHub',
  message: 'Which repository should I use?',
  mode: 'form',
  requestedSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', title: 'Repository' },
      count: { type: 'integer', title: 'How many' },
      draft: { type: 'boolean', title: 'Draft' },
    },
    required: ['repo'],
  },
};

const urlRequest: ElicitationRequest = {
  requestId: 'e2',
  serverName: 'linear',
  message: 'Sign in to Linear to continue',
  mode: 'url',
  url: 'https://linear.app/oauth/authorize?x=1',
  elicitationId: 'el-9',
};

function setup(request: ElicitationRequest | null) {
  const onAccept = vi.fn();
  const onDecline = vi.fn();
  const onCancel = vi.fn();
  const openUrl = vi.fn(async () => {});
  render(
    <ElicitationDialog
      request={request}
      onAccept={onAccept}
      onDecline={onDecline}
      onCancel={onCancel}
      openUrl={openUrl}
    />,
  );
  return { onAccept, onDecline, onCancel, openUrl };
}

describe('ElicitationDialog — form mode', () => {
  it('shows the server, the question and one input per schema field', () => {
    setup(formRequest);
    expect(screen.getByText(/GitHub/)).toBeTruthy();
    expect(screen.getByText('Which repository should I use?')).toBeTruthy();
    expect(screen.getByLabelText(/Repository/)).toBeTruthy();
    expect(screen.getByLabelText(/How many/)).toBeTruthy();
    expect(screen.getByLabelText(/Draft/)).toBeTruthy();
  });

  it('will not submit with a required field empty', () => {
    const { onAccept } = setup(formRequest);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.getByText('Required')).toBeTruthy();
  });

  it('submits the typed content', () => {
    const { onAccept } = setup(formRequest);
    fireEvent.change(screen.getByLabelText(/Repository/), { target: { value: 'omnifex' } });
    fireEvent.change(screen.getByLabelText(/How many/), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText(/Draft/));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onAccept).toHaveBeenCalledWith('e1', { repo: 'omnifex', count: 2, draft: true });
  });

  it('declines on Decline', () => {
    const { onDecline, onAccept } = setup(formRequest);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onDecline).toHaveBeenCalledWith('e1');
    expect(onAccept).not.toHaveBeenCalled();
  });

  // MCP distinguishes an explicit "no" from walking away; Esc is the latter.
  it('cancels, not declines, when dismissed', () => {
    const { onCancel, onDecline } = setup(formRequest);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledWith('e1');
    expect(onDecline).not.toHaveBeenCalled();
  });
});

describe('ElicitationDialog — URL mode', () => {
  it('shows the full URL so the user can see where it goes', () => {
    setup(urlRequest);
    expect(screen.getByText('https://linear.app/oauth/authorize?x=1')).toBeTruthy();
  });

  it('opens the URL and accepts without content on Open', async () => {
    const { onAccept, openUrl } = setup(urlRequest);
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }));
    expect(openUrl).toHaveBeenCalledWith('https://linear.app/oauth/authorize?x=1');
    expect(onAccept).toHaveBeenCalledWith('e2', undefined);
  });
});

describe('ElicitationDialog — closed', () => {
  it('renders nothing without a request', () => {
    setup(null);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
