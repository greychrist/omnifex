import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  ENTITLEMENTS,
  entitlementsFor,
  osxNotarizeConfig,
} from '../../signing';

// What the bundled node (`Contents/MacOS/omnifexd`) needs under hardened
// runtime. V8 JITs, so it must be allowed to mark memory executable and run
// code it generated itself, and it loads the better-sqlite3 / node-pty .node
// addons, so library validation comes off. The Swift app needs nothing beyond
// hardened runtime: the web view's JIT runs in WebKit's own processes.
const REQUIRED_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
];

function readPlist(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

describe('macOS signing configuration', () => {
  describe('entitlements', () => {
    it('ships the node entitlements plist', () => {
      expect(fs.existsSync(ENTITLEMENTS)).toBe(true);
      expect(path.isAbsolute(ENTITLEMENTS)).toBe(true);
    });

    it.each(REQUIRED_ENTITLEMENTS)('grants node %s', (key) => {
      expect(readPlist(ENTITLEMENTS)).toContain(key);
    });

    it('does not request device entitlements nothing uses', () => {
      const main = readPlist(ENTITLEMENTS);
      expect(main).not.toContain('com.apple.security.device.camera');
      expect(main).not.toContain('com.apple.security.device.audio-input');
      expect(main).not.toContain('com.apple.security.device.bluetooth');
      expect(main).not.toContain('com.apple.security.device.usb');
    });

    it('gives the bundled node the node entitlements, and everything else none', () => {
      expect(entitlementsFor('/out/OmniFex.app/Contents/MacOS/omnifexd')).toBe(ENTITLEMENTS);
      expect(entitlementsFor('/out/OmniFex.app')).toBeNull();
      expect(entitlementsFor('/out/OmniFex.app/Contents/Resources/app/node_modules/node-pty/build/Release/spawn-helper')).toBeNull();
      expect(entitlementsFor('/out/OmniFex.app/Contents/Resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node')).toBeNull();
    });
  });

  describe('osxNotarizeConfig', () => {
    it('is undefined by default so local builds do not hit Apple', () => {
      expect(osxNotarizeConfig({})).toBeUndefined();
    });

    it('is undefined unless notarization is explicitly opted into', () => {
      expect(osxNotarizeConfig({ APPLE_KEYCHAIN_PROFILE: 'omnifex-notary' }))
        .toBeUndefined();
    });

    it('uses the keychain profile so no secret is read from the environment', () => {
      const cfg = osxNotarizeConfig({ OMNIFEX_NOTARIZE: '1' });
      expect(cfg).toEqual({ keychainProfile: 'omnifex-notary' });
    });

    it('allows the keychain profile name to be overridden', () => {
      const cfg = osxNotarizeConfig({
        OMNIFEX_NOTARIZE: '1',
        APPLE_KEYCHAIN_PROFILE: 'other-profile',
      });
      expect(cfg).toEqual({ keychainProfile: 'other-profile' });
    });
  });
});
