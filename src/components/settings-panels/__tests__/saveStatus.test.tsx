// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import {
  SaveStatusProvider,
  SaveStatusBanner,
  useSaveStatus,
  SAVED_VISIBLE_MS,
} from '../saveStatus';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Exposes `track` to the test body. */
function Harness({ onTrack }: { onTrack: (t: ReturnType<typeof useSaveStatus>['track']) => void }) {
  const { track } = useSaveStatus();
  onTrack(track);
  return <SaveStatusBanner />;
}

function setup() {
  let track!: ReturnType<typeof useSaveStatus>['track'];
  render(
    <SaveStatusProvider>
      <Harness onTrack={(t) => { track = t; }} />
    </SaveStatusProvider>,
  );
  return () => track;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const status = () => screen.getByRole('status');

describe('save status', () => {
  it('shows nothing until something is saved', () => {
    setup();
    expect(status().textContent).toBe('');
  });

  it('reports Saving… while a write is in flight, then Saved', async () => {
    const track = setup();
    const d = deferred();
    let result: Promise<boolean>;
    act(() => { result = track()(d.promise); });
    expect(status().textContent).toMatch(/Saving/);
    await act(async () => { d.resolve(); await result; });
    expect(status().textContent).toMatch(/Saved/);
    await expect(result!).resolves.toBe(true);
  });

  it('clears Saved after a moment', async () => {
    vi.useFakeTimers();
    const track = setup();
    await act(async () => { await track()(Promise.resolve()); });
    expect(status().textContent).toMatch(/Saved/);
    act(() => { vi.advanceTimersByTime(SAVED_VISIBLE_MS); });
    expect(status().textContent).toBe('');
  });

  it('reports a failure with its message and resolves false instead of throwing', async () => {
    const track = setup();
    let ok: boolean | undefined;
    await act(async () => { ok = await track()(Promise.reject(new Error('disk full'))); });
    expect(ok).toBe(false);
    expect(status().textContent).toMatch(/Couldn.t save/);
    expect(status().textContent).toMatch(/disk full/);
  });

  it('keeps a failure on screen until a later save succeeds', async () => {
    vi.useFakeTimers();
    const track = setup();
    await act(async () => { await track()(Promise.reject(new Error('disk full'))); });
    act(() => { vi.advanceTimersByTime(SAVED_VISIBLE_MS * 5); });
    expect(status().textContent).toMatch(/disk full/);
    await act(async () => { await track()(Promise.resolve()); });
    expect(status().textContent).toMatch(/Saved/);
  });

  it('says Saved only once every overlapping write has landed, and fails if any did', async () => {
    const track = setup();
    const a = deferred();
    const b = deferred();
    let pa: Promise<boolean>, pb: Promise<boolean>;
    act(() => { pa = track()(a.promise); pb = track()(b.promise); });
    await act(async () => { a.reject(new Error('first failed')); await pa; });
    expect(status().textContent).toMatch(/Saving/);
    await act(async () => { b.resolve(); await pb; });
    expect(status().textContent).toMatch(/first failed/);
  });

  it('tracks a synchronous write and reports what it throws', async () => {
    const track = setup();
    await act(async () => { await track()(() => { throw new Error('quota'); }); });
    expect(status().textContent).toMatch(/quota/);
    await act(async () => { await track()(() => undefined); });
    expect(status().textContent).toMatch(/Saved/);
  });

  it('still resolves the outcome outside a provider, so panels render standalone', async () => {
    let track: ReturnType<typeof useSaveStatus>['track'] | undefined;
    render(<Harness onTrack={(t) => { track = t; }} />);
    await expect(track!(Promise.resolve())).resolves.toBe(true);
    await expect(track!(Promise.reject(new Error('x')))).resolves.toBe(false);
  });

  describe('banner', () => {
    it('is hidden while idle and takes the tone of each outcome', async () => {
      const track = setup();
      expect(status().dataset.state).toBe('idle');
      expect(status().getAttribute('aria-hidden')).toBeNull();
      const d = deferred();
      let p: Promise<boolean>;
      act(() => { p = track()(d.promise); });
      expect(status().dataset.state).toBe('saving');
      await act(async () => { d.resolve(); await p; });
      expect(status().dataset.state).toBe('saved');
      await act(async () => { await track()(Promise.reject(new Error('disk full'))); });
      expect(status().dataset.state).toBe('error');
    });

    it('lets a failure be dismissed', async () => {
      const track = setup();
      await act(async () => { await track()(Promise.reject(new Error('disk full'))); });
      fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
      expect(status().dataset.state).toBe('idle');
      expect(status().textContent).toBe('');
    });

    it('offers no dismiss button for a success', async () => {
      const track = setup();
      await act(async () => { await track()(Promise.resolve()); });
      expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
    });
  });
});
