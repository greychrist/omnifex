// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createPlatform, type NativeBridge } from '@/lib/platform';

const fakeBridge = () => {
  const invoke = vi.fn<NativeBridge['invoke']>().mockResolvedValue(undefined);
  const bridge: NativeBridge = { invoke, onEvent: () => () => {} };
  return { bridge, invoke };
};

describe('createPlatform(bridge).openExternal', () => {
  // The main handler is `(_event, url: string) => shell.openExternal(url)`:
  // an object there is rejected by Electron and the browser never opens.
  it('hands the bridge the bare url string', async () => {
    const { bridge, invoke } = fakeBridge();
    await createPlatform(bridge).openExternal('https://x');
    expect(invoke).toHaveBeenCalledWith('shell:openExternal', 'https://x');
    expect(typeof invoke.mock.calls[0][1]).toBe('string');
  });

  // OAuth URLs come from a server's metadata: refuse anything not http(s).
  it('refuses a non-http(s) url without invoking the bridge', async () => {
    const { bridge, invoke } = fakeBridge();
    await expect(createPlatform(bridge).openExternal('file:///etc/passwd')).rejects.toThrow(/Unsafe protocol/);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('createPlatform(bridge).openPath', () => {
  it('invokes open_path with the path and the directory to resolve it against', async () => {
    const { bridge, invoke } = fakeBridge();
    await createPlatform(bridge).openPath('reports/a.md', '/proj');
    expect(invoke).toHaveBeenCalledWith('open_path', { path: 'reports/a.md', cwd: '/proj' });
  });

  // Strip undefined before crossing IPC.
  it('omits cwd when there is none', async () => {
    const { bridge, invoke } = fakeBridge();
    await createPlatform(bridge).openPath('/tmp/a.md');
    expect(invoke).toHaveBeenCalledWith('open_path', { path: '/tmp/a.md' });
  });

  it('is unsupported in the web client', async () => {
    await expect(createPlatform(null).openPath('/tmp/a.md')).rejects.toThrow(/not available in the web client/);
  });
});
