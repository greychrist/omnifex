import { describe, it, expect } from 'vitest';
import { getHandlerMap } from '../ipc/handlers';
import { INVOKE_CHANNELS } from '../ipc/channels';

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
});
