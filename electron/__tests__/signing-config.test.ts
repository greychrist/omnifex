import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  ENTITLEMENTS,
  ENTITLEMENTS_INHERIT,
  optionsForFile,
  osxNotarizeConfig,
} from '../../signing';

// Entitlements Electron needs under hardened runtime. V8 JITs, so it must be
// allowed to mark memory executable and run code it generated itself; the app
// loads better-sqlite3 / node-pty .node addons and spawns node-pty's
// spawn-helper, so library validation has to come off; and the Brain MCP
// server is launched as `process.execPath` with ELECTRON_RUN_AS_NODE=1, which
// means the child is started with a modified environment.
const REQUIRED_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.cs.allow-dyld-environment-variables',
];

function readPlist(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

describe('macOS signing configuration', () => {
  describe('entitlements files', () => {
    it('ships a main entitlements plist', () => {
      expect(fs.existsSync(ENTITLEMENTS)).toBe(true);
    });

    it('ships an inherit entitlements plist for child processes', () => {
      expect(fs.existsSync(ENTITLEMENTS_INHERIT)).toBe(true);
    });

    it.each(REQUIRED_ENTITLEMENTS)('main plist grants %s', (key) => {
      expect(readPlist(ENTITLEMENTS)).toContain(key);
    });

    // @electron/osx-sign ships no non-MAS inherit plist, and helper processes
    // are signed separately from the main binary — an entitlement missing here
    // fails at runtime in the helper, not at signing time.
    it.each(REQUIRED_ENTITLEMENTS)('inherit plist grants %s', (key) => {
      expect(readPlist(ENTITLEMENTS_INHERIT)).toContain(key);
    });

    it('does not request device entitlements the app never uses', () => {
      // osx-sign's default.darwin.plist asks for camera, mic, bluetooth and
      // USB. OmniFex uses none of them, and requesting them invites TCC
      // prompts for hardware the app never touches.
      const main = readPlist(ENTITLEMENTS);
      expect(main).not.toContain('com.apple.security.device.camera');
      expect(main).not.toContain('com.apple.security.device.audio-input');
      expect(main).not.toContain('com.apple.security.device.bluetooth');
      expect(main).not.toContain('com.apple.security.device.usb');
    });
  });

  describe('optionsForFile', () => {
    it('enables hardened runtime, which notarization requires', () => {
      expect(optionsForFile('/tmp/OmniFex.app').hardenedRuntime).toBe(true);
    });

    it('gives the main app bundle the main entitlements', () => {
      const opts = optionsForFile('/tmp/out/OmniFex.app');
      expect(opts.entitlements).toBe(ENTITLEMENTS);
    });

    it.each([
      '/tmp/out/OmniFex.app/Contents/Frameworks/OmniFex Helper.app',
      '/tmp/out/OmniFex.app/Contents/Frameworks/OmniFex Helper (GPU).app',
      '/tmp/out/OmniFex.app/Contents/Frameworks/OmniFex Helper (Renderer).app',
      '/tmp/out/OmniFex.app/Contents/Frameworks/OmniFex Helper (Plugin).app',
    ])('gives %s the inherit entitlements', (filePath) => {
      expect(optionsForFile(filePath).entitlements).toBe(ENTITLEMENTS_INHERIT);
    });

    it('points at entitlements files that actually exist', () => {
      for (const p of [ENTITLEMENTS, ENTITLEMENTS_INHERIT]) {
        expect(fs.existsSync(p)).toBe(true);
        expect(path.isAbsolute(p)).toBe(true);
      }
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
