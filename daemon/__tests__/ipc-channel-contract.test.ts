import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { getHandlerMap } from '../ipc/handlers';
import { INVOKE_CHANNELS } from '../ipc/channels';
import { TYPED_SESSION_CHANNELS } from '../remote/rpc-allowlist';
import { NATIVE_EVENT_PREFIXES, NATIVE_INVOKE_CHANNELS } from '../../src/lib/remote/nativeChannels';

/**
 * Every channel the renderer may invoke has exactly one owner:
 *
 *  - the daemon's handler map, reached as `rpc.invoke`;
 *  - a typed session method, which the renderer's shim translates;
 *  - the native Mac app.
 *
 * A channel with no owner is a dead channel — api.ts can call it, and nothing
 * answers. A channel with two is worse: a native channel the daemon also
 * serves is reachable from an iPad, where its answer describes the wrong
 * machine, and the subtractive rpc allowlist would let it through if the
 * native list ever forgot it.
 */
describe('IPC channel contract', () => {
  const allow = new Set(INVOKE_CHANNELS);
  const daemon = new Set(Object.keys(getHandlerMap()));
  const typed = new Set(TYPED_SESSION_CHANNELS);
  const native = new Set(NATIVE_INVOKE_CHANNELS);

  it('the invoke list has no duplicate entries', () => {
    expect(INVOKE_CHANNELS.length).toBe(allow.size);
  });

  it('every daemon handler is a channel the renderer may invoke', () => {
    expect([...daemon].filter((ch) => !allow.has(ch))).toEqual([]);
  });

  it('every channel has an owner', () => {
    const dead = [...allow].filter((ch) => !daemon.has(ch) && !typed.has(ch) && !native.has(ch));
    expect(dead).toEqual([]);
  });

  it('no channel has two owners', () => {
    const both = [...native].filter((ch) => daemon.has(ch) || typed.has(ch));
    expect(both).toEqual([]);
    expect([...typed].filter((ch) => daemon.has(ch))).toEqual([]);
  });

  it('names no native or typed channel the renderer cannot invoke', () => {
    // Reverse drift: an entry left behind after its channel was renamed or
    // removed routes nothing.
    expect(NATIVE_INVOKE_CHANNELS.filter((ch) => !allow.has(ch))).toEqual([]);
    expect(TYPED_SESSION_CHANNELS.filter((ch) => !allow.has(ch))).toEqual([]);
  });

  it('exposes the account-identity channels with registered handlers', () => {
    // Named explicitly so a half-wired change fails on the specific feature
    // rather than only in the generic sweep above.
    for (const ch of ['account_identity_read', 'account_identity_probe']) {
      expect(allow.has(ch)).toBe(true);
      expect(daemon.has(ch)).toBe(true);
    }
  });
});

/**
 * The Swift side of the native list. `NativeChannels.swift` names every
 * channel the app routes as a string literal; a channel the renderer sends to
 * the bridge that the app does not route is rejected with "Blocked IPC
 * channel" — at runtime, on the one platform no test here runs.
 */
describe('native channels in the Swift app', () => {
  const swift = fs.readFileSync(
    path.join(__dirname, '..', '..', 'macos', 'Sources', 'OmniFexCore', 'NativeChannels.swift'),
    'utf8',
  );
  const literals = new Set([...swift.matchAll(/"([^"\\]+)"/g)].map((m) => m[1]));

  it('routes every native invoke channel', () => {
    expect(NATIVE_INVOKE_CHANNELS.filter((ch) => !literals.has(ch))).toEqual([]);
  });

  it('emits on every native event channel the shim routes to it', () => {
    // Prefixes (`updater:`) match the full names the app emits on.
    const emitted = [...literals];
    const unserved = NATIVE_EVENT_PREFIXES.filter((p) => !emitted.some((l) => l === p || l.startsWith(p)));
    expect(unserved).toEqual([]);
  });

  it('routes nothing the renderer would not send it', () => {
    const invokeLiterals = [...literals].filter((l) => INVOKE_CHANNELS.includes(l));
    expect(invokeLiterals.filter((ch) => !NATIVE_INVOKE_CHANNELS.includes(ch))).toEqual([]);
  });
});
