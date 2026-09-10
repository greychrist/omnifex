import { describe, it, expect } from 'vitest';
import { getHandlerMap } from '../ipc/handlers';
import { INVOKE_CHANNELS } from '../ipc/channels';
import { NATIVE_INVOKE_CHANNELS } from '../../src/lib/remote/nativeChannels';

// Channels that are registered directly via `ipcMain.handle` rather than through
// `getHandlerMap()`. Two homes:
//   - electron/ipc/handlers.ts `registerIpcHandlers` (dialog/window/shell/etc.)
//   - electron/main.ts (app version, updater, tab-status)
// If you add a new direct `ipcMain.handle` channel, add it here too — that's the
// intended friction: it forces the allow-list and the registration to agree.
const DIRECTLY_REGISTERED_CHANNELS = [
  // handlers.ts — registerIpcHandlers tail
  'dialog:open',
  'dialog:save',
  'shell:openExternal',
  'reveal_path_in_finder',
  'window:minimize',
  'window:maximize',
  'window:close',
  'save_pasted_image',
  // main.ts
  'get_app_version',
  'updater:check',
  'updater:download',
  'updater:open',
  'updater:install',
  'updater:install-cancel',
  'tab_status_publish',
  'tab_status_remove',
  'tab_status_list',
  // main.ts — OmniFex Remote (daemon discovery + native notification relay)
  'remote:url',
  'remote:restart',
  'notify:show',
] as const;

describe('IPC channel contract', () => {
  const allow = new Set(INVOKE_CHANNELS);
  const registered = new Set<string>([
    ...Object.keys(getHandlerMap()),
    ...DIRECTLY_REGISTERED_CHANNELS,
  ]);

  it('the invoke allow-list has no duplicate entries', () => {
    expect(INVOKE_CHANNELS.length).toBe(allow.size);
  });

  it('every registered handler channel is in the preload allow-list', () => {
    // A handler with no allow-list entry is unreachable — the renderer's invoke
    // is blocked at the preload gate.
    const missing = [...registered].filter((ch) => !allow.has(ch));
    expect(missing).toEqual([]);
  });

  it('every allow-listed channel has a registered handler (no dead channels)', () => {
    // An allow-list entry with no handler is the dead-channel class: api.ts can
    // call it, it passes the gate, then there's nothing on the other side.
    const dead = [...allow].filter((ch) => !registered.has(ch));
    expect(dead).toEqual([]);
  });

  it('exposes the account-identity channels with registered handlers', () => {
    // Named explicitly so a half-wired change fails on the specific feature
    // rather than only in the generic sweep above.
    for (const ch of ['account_identity_read', 'account_identity_probe']) {
      expect(allow.has(ch)).toBe(true);
      expect(registered.has(ch)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Native-only routing
// ---------------------------------------------------------------------------
//
// Remote mode is the default, so `rpc.invoke` reaches every allow-listed
// channel that isn't explicitly denied (the allow-list is subtractive — see
// `electron/remote/rpc-allowlist.ts`). A channel whose handler needs a service
// the daemon's adapter bag doesn't build optional-chains to `null` instead of
// failing, and a `null` that means "not configured" is indistinguishable from
// a `null` that means "wrong process". These two tests are the guardrail.

/**
 * Adapters constructed only in `electron/main.ts`. `electron/remote/daemon.ts`
 * builds no equivalent — they need a BrowserWindow, a display, or a pty.
 * Keep in sync by construction: the probe below finds the channels.
 */
const MAIN_ONLY_ADAPTERS = [
  'costReportPdf',
  'notificationSounds',
  'oneShotTerminal',
  'codexAuth',
] as const;

/**
 * Every channel whose handler reads `services[adapter]`.
 *
 * Found by invoking each handler with an empty payload against a bag holding
 * one probe and nothing else: with every other adapter `undefined`, handlers
 * optional-chain to `null` and do no work. `await` before reading the flag so
 * an async handler that touches the probe after a tick is still attributed to
 * its own channel.
 */
async function channelsReaching(adapter: string): Promise<string[]> {
  let touched = false;
  const probe = new Proxy({}, {
    get: (_target, prop) => {
      // `then` and symbol lookups are the await machinery inspecting the
      // value, not the handler using the service.
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      touched = true;
      return () => null;
    },
  });
  const map = getHandlerMap({ [adapter]: probe } as never);
  const hits: string[] = [];
  for (const [channel, fn] of Object.entries(map)) {
    touched = false;
    try {
      await fn({});
    } catch {
      // A handler starved of its adapters may throw; it either touched the
      // probe on the way or it never needed it.
    }
    if (touched) hits.push(channel);
  }
  return hits;
}

describe('native-only channel routing', () => {
  const native = new Set(NATIVE_INVOKE_CHANNELS);

  it('marks every channel that reaches a main-only adapter as native-only', async () => {
    const leaked: string[] = [];
    for (const adapter of MAIN_ONLY_ADAPTERS) {
      for (const channel of await channelsReaching(adapter)) {
        if (!native.has(channel)) leaked.push(`${channel} (${adapter})`);
      }
    }
    // A leak here reaches the daemon, whose bag has no such service, and comes
    // back as a silent `null`.
    expect(leaked).toEqual([]);
  });

  it('marks every directly-registered channel as native-only', () => {
    // `getHandlerMap` is the only handler surface the daemon serves. Anything
    // registered straight onto `ipcMain` exists in the Electron process alone.
    const leaked = DIRECTLY_REGISTERED_CHANNELS.filter((ch) => !native.has(ch));
    expect(leaked).toEqual([]);
  });

  it('names no channel that is not in the preload allow-list', () => {
    // Guards the reverse drift: a native entry left behind after its channel
    // was renamed or removed would silently route nothing.
    const stale = NATIVE_INVOKE_CHANNELS.filter((ch) => !new Set(INVOKE_CHANNELS).has(ch));
    expect(stale).toEqual([]);
  });
});
