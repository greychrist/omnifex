// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installNativeClipboard } from '@/lib/remote/nativeClipboard';
import type { NativeBridge } from '@/lib/platform';

/**
 * The Mac app's page comes from the daemon over plain http on the tailnet
 * address, which WebKit does not count as a secure context — so
 * `navigator.clipboard` and `ClipboardItem` do not exist there, and every
 * copy button threw. The app's bridge supplies the clipboard instead.
 */

function bridge() {
  const invoke = vi.fn(async () => null);
  return { native: { invoke, onEvent: vi.fn() } as unknown as NativeBridge, invoke };
}

afterEach(() => {
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  delete (globalThis as unknown as { ClipboardItem?: unknown }).ClipboardItem;
});

describe('installNativeClipboard', () => {
  it('routes writeText to the native clipboard when the page has none', async () => {
    const { native, invoke } = bridge();
    installNativeClipboard(native);
    await navigator.clipboard.writeText('hello');
    expect(invoke).toHaveBeenCalledWith('clipboard:write', { items: [{ type: 'text/plain', text: 'hello' }] });
  });

  it('routes write() of a PNG ClipboardItem as base64', async () => {
    const { native, invoke } = bridge();
    installNativeClipboard(native);
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    expect(invoke).toHaveBeenCalledWith('clipboard:write', { items: [{ type: 'image/png', base64: 'AQID' }] });
  });

  it('sends text entries of a ClipboardItem as text, including promised ones', async () => {
    const { native, invoke } = bridge();
    installNativeClipboard(native);
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/plain': Promise.resolve(new Blob(['a b'], { type: 'text/plain' })) }),
    ]);
    expect(invoke).toHaveBeenCalledWith('clipboard:write', { items: [{ type: 'text/plain', text: 'a b' }] });
  });

  it('rejects when the native write fails, so callers keep their error path', async () => {
    const { native, invoke } = bridge();
    invoke.mockRejectedValueOnce(new Error('denied'));
    installNativeClipboard(native);
    await expect(navigator.clipboard.writeText('x')).rejects.toThrow('denied');
  });

  // From loopback the page has WebKit's own clipboard, but WebKit refuses a
  // write that comes after an await (image copy encodes the PNG first). The
  // pasteboard has no such rule, so the Mac keeps the native writes and only
  // borrows the page's read side.
  it('replaces the write side of a real clipboard, keeping its reads', async () => {
    const readText = vi.fn(async () => 'from page');
    const real = { writeText: vi.fn(), write: vi.fn(), readText, read: vi.fn() };
    Object.defineProperty(navigator, 'clipboard', { value: real, configurable: true });
    const { native, invoke } = bridge();
    installNativeClipboard(native);
    await navigator.clipboard.writeText('x');
    expect(real.writeText).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('clipboard:write', { items: [{ type: 'text/plain', text: 'x' }] });
    expect(await navigator.clipboard.readText()).toBe('from page');
  });
});
