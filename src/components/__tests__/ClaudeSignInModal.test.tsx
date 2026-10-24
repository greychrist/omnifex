// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { apiMock, platformMock, openSignInLink } = vi.hoisted(() => ({
  apiMock: {
    claudeSignInBegin: vi.fn(),
    claudeSignInWait: vi.fn(),
    claudeSignInSubmitCode: vi.fn(),
    claudeSignInCancel: vi.fn(),
  },
  platformMock: { isDesktop: true, openExternal: vi.fn(async () => {}) },
  openSignInLink: vi.fn(async () => {}),
}));

vi.mock('@/lib/api', () => ({ api: apiMock }));
vi.mock('@/lib/platform', () => ({ platform: platformMock }));
vi.mock('@/lib/signInBrowser', () => ({ openSignInLink }));

import { ClaudeSignInModal } from '../ClaudeSignInModal';

const CONFIG_DIR = '/Users/me/.claude-work';
const FLOW = { flowId: 'f1', manualUrl: 'https://manual', automaticUrl: 'https://automatic' };
const ACCOUNT = { email: 'me@example.com', organization: 'Work' };

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let wait: ReturnType<typeof deferred<typeof ACCOUNT>>;

beforeEach(() => {
  for (const f of Object.values(apiMock)) f.mockReset();
  openSignInLink.mockClear();
  platformMock.openExternal.mockClear();
  platformMock.isDesktop = true;
  wait = deferred();
  apiMock.claudeSignInBegin.mockResolvedValue(FLOW);
  apiMock.claudeSignInWait.mockReturnValue(wait.promise);
  apiMock.claudeSignInCancel.mockResolvedValue(undefined);
});

afterEach(() => { cleanup(); });

async function openModal(props: Partial<Parameters<typeof ClaudeSignInModal>[0]> = {}) {
  await act(async () => {
    render(<ClaudeSignInModal open onClose={() => {}} configDir={CONFIG_DIR} accountName="Work" {...props} />);
  });
}

describe('ClaudeSignInModal', () => {
  it('starts nothing while closed', () => {
    render(<ClaudeSignInModal open={false} onClose={() => {}} configDir={CONFIG_DIR} />);
    expect(apiMock.claudeSignInBegin).not.toHaveBeenCalled();
  });

  it("on the Mac, opens the sign-in page in the account's browser and waits for it", async () => {
    await openModal();
    expect(screen.getByText('Sign in to Claude — Work')).toBeTruthy();
    expect(apiMock.claudeSignInBegin).toHaveBeenCalledWith(CONFIG_DIR);
    expect(openSignInLink).toHaveBeenCalledWith('https://automatic', CONFIG_DIR);
    expect(apiMock.claudeSignInWait).toHaveBeenCalledWith('f1');
  });

  it('closes and reports who signed in when the browser finishes', async () => {
    const onClose = vi.fn();
    const onAuthenticated = vi.fn();
    await openModal({ onClose, onAuthenticated });
    await act(async () => { wait.resolve(ACCOUNT); });
    expect(onAuthenticated).toHaveBeenCalledWith(ACCOUNT);
    expect(onClose).toHaveBeenCalled();
  });

  it('can open the page again', async () => {
    await openModal();
    fireEvent.click(screen.getByRole('button', { name: 'Open again' }));
    expect(openSignInLink).toHaveBeenLastCalledWith('https://automatic', CONFIG_DIR);
  });

  it('accepts a pasted code instead', async () => {
    const onAuthenticated = vi.fn();
    apiMock.claudeSignInSubmitCode.mockResolvedValue(ACCOUNT);
    await openModal({ onAuthenticated });
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'abc#st' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); });
    expect(apiMock.claudeSignInSubmitCode).toHaveBeenCalledWith('f1', 'abc#st');
    expect(onAuthenticated).toHaveBeenCalledWith(ACCOUNT);
  });

  it('keeps the dialog up with the error after a bad code', async () => {
    const onClose = vi.fn();
    apiMock.claudeSignInSubmitCode.mockRejectedValue(new Error('Request failed with status code 400'));
    await openModal({ onClose });
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'bad' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); });
    expect(screen.getByRole('alert').textContent).toMatch(/didn.t work|400/);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Code')).toBeTruthy();
  });

  it('shows why when the sign-in cannot start', async () => {
    apiMock.claudeSignInBegin.mockRejectedValue(new Error('claude binary not found'));
    await openModal();
    expect(screen.getByRole('alert').textContent).toContain('claude binary not found');
  });

  it('cancels the sign-in when closed before it finishes', async () => {
    const view = await (async () => {
      let r!: ReturnType<typeof render>;
      await act(async () => { r = render(<ClaudeSignInModal open onClose={() => {}} configDir={CONFIG_DIR} />); });
      return r;
    })();
    await act(async () => { view.rerender(<ClaudeSignInModal open={false} onClose={() => {}} configDir={CONFIG_DIR} />); });
    expect(apiMock.claudeSignInCancel).toHaveBeenCalledWith('f1');
  });

  it('on a web client, opens the code page from the button and does not wait on localhost', async () => {
    platformMock.isDesktop = false;
    await openModal();
    expect(openSignInLink).not.toHaveBeenCalled();
    expect(apiMock.claudeSignInWait).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open sign-in page' }));
    expect(platformMock.openExternal).toHaveBeenCalledWith('https://manual');
    expect(screen.getByLabelText('Code')).toBeTruthy();
  });
});
