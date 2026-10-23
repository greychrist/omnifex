import { describe, it, expect, vi } from 'vitest';

import { createTailnetWatch } from '../remote/tailnet-watch';

// A daemon launched before Tailscale came up (login at boot, wake from sleep)
// found no tailnet address and listened on loopback only — the iPad lost it
// until the next restart. The watch adds the address when it appears.
describe('tailnet watch', () => {
  function make(ip: string | null, hosts: string[] = ['127.0.0.1'], added = true) {
    const listening = [...hosts];
    const addHost = vi.fn(async (h: string) => { if (added) listening.push(h); return added; });
    const info = vi.fn();
    const warn = vi.fn();
    let current = ip;
    const watch = createTailnetWatch({ detect: () => current, listening: () => listening, addHost, log: { info, warn } });
    return { watch, addHost, info, warn, setIp: (v: string | null) => { current = v; } };
  }

  it('does nothing while there is no tailnet address', async () => {
    const { watch, addHost } = make(null);
    await watch.check();
    expect(addHost).not.toHaveBeenCalled();
  });

  it('listens on the address once it appears, once', async () => {
    const { watch, addHost, info, setIp } = make(null);
    await watch.check();
    setIp('100.95.1.2');
    await watch.check();
    await watch.check();
    expect(addHost).toHaveBeenCalledTimes(1);
    expect(addHost).toHaveBeenCalledWith('100.95.1.2');
    expect(info).toHaveBeenCalledWith('now listening on the tailnet address', { host: '100.95.1.2' });
  });

  it('says so when the address cannot be bound, and tries again next time', async () => {
    const { watch, addHost, warn } = make('100.95.1.2', ['127.0.0.1'], false);
    await watch.check();
    await watch.check();
    expect(addHost).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('could not listen on the tailnet address', { host: '100.95.1.2' });
  });
});
