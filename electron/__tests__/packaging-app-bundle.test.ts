import { describe, expect, it } from 'vitest';

import {
  bundleLayout,
  infoPlist,
  isMachO,
  shipsNativeFile,
  signingOrder,
} from '../../packaging/app-bundle';

describe('infoPlist', () => {
  const plist = infoPlist({ name: 'OmniFex', bundleId: 'com.omnifex.app', version: '0.5.0' });

  it('names the Swift executable and keeps the bundle id the Electron app had', () => {
    // Same id, so the one other person's install updates in place and keeps
    // its notification permission (both keyed on the id).
    expect(plist).toMatch(/<key>CFBundleIdentifier<\/key>\s*<string>com\.omnifex\.app<\/string>/);
    expect(plist).toMatch(/<key>CFBundleExecutable<\/key>\s*<string>OmniFex<\/string>/);
  });

  // The Electron updater refuses a staged app whose short version is not the
  // one it downloaded; this is the field it reads.
  it('carries the version in both version keys', () => {
    expect(plist).toMatch(/<key>CFBundleShortVersionString<\/key>\s*<string>0\.5\.0<\/string>/);
    expect(plist).toMatch(/<key>CFBundleVersion<\/key>\s*<string>0\.5\.0<\/string>/);
  });

  it('requires macOS 27', () => {
    expect(plist).toMatch(/<key>LSMinimumSystemVersion<\/key>\s*<string>27\.0<\/string>/);
  });

  // The page is plain http from the daemon, on 127.0.0.1 or a Tailscale
  // 100.x address — neither of which App Transport Security allows by default.
  it('lets the web view load the daemon over plain http', () => {
    expect(plist).toMatch(/<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>NSAllowsArbitraryLoadsInWebContent<\/key>\s*<true\/>/);
  });

  it('escapes XML in values', () => {
    expect(infoPlist({ name: 'A & <B>', bundleId: 'x', version: '1.0.0' })).toContain('A &amp; &lt;B&gt;');
  });
});

describe('bundleLayout', () => {
  it('puts node and the app beside each other, and the daemon two levels under Resources', () => {
    const l = bundleLayout('/out/OmniFex.app');
    expect(l.executable).toBe('/out/OmniFex.app/Contents/MacOS/OmniFex');
    expect(l.node).toBe('/out/OmniFex.app/Contents/MacOS/omnifexd');
    expect(l.appRoot).toBe('/out/OmniFex.app/Contents/Resources/app');
    expect(l.build).toBe('/out/OmniFex.app/Contents/Resources/app/build');
    // build/../.. is Resources: where webroot.ts and bundled-mod.ts look.
    expect(l.webRoot).toBe('/out/OmniFex.app/Contents/Resources/dist-web');
    expect(l.mod).toBe('/out/OmniFex.app/Contents/Resources/omnifex-mod');
  });
});

describe('isMachO', () => {
  it('recognises 64-bit and universal binaries in either byte order', () => {
    expect(isMachO(Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe]))).toBe(true);
    expect(isMachO(Uint8Array.from([0xfe, 0xed, 0xfa, 0xcf]))).toBe(true);
    expect(isMachO(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe]))).toBe(true);
  });

  it('rejects scripts, text and short files', () => {
    expect(isMachO(Buffer.from('#!/bin/sh\n'))).toBe(false);
    expect(isMachO(Uint8Array.from([0xcf, 0xfa]))).toBe(false);
  });
});

describe('shipsNativeFile', () => {
  it('ships the addon and its JS, not its sources or other platforms', () => {
    expect(shipsNativeFile('better-sqlite3', 'build/Release/better_sqlite3.node')).toBe(true);
    expect(shipsNativeFile('better-sqlite3', 'lib/database.js')).toBe(true);
    expect(shipsNativeFile('better-sqlite3', 'package.json')).toBe(true);
    expect(shipsNativeFile('better-sqlite3', 'deps/sqlite3/sqlite3.c')).toBe(false);
    expect(shipsNativeFile('better-sqlite3', 'build/Release/test_extension.node')).toBe(false);
    expect(shipsNativeFile('better-sqlite3', 'build/Release/obj.target/foo.o')).toBe(false);
  });

  it('ships node-pty with its spawn-helper, which it posix_spawns', () => {
    expect(shipsNativeFile('node-pty', 'build/Release/pty.node')).toBe(true);
    expect(shipsNativeFile('node-pty', 'build/Release/spawn-helper')).toBe(true);
    expect(shipsNativeFile('node-pty', 'lib/index.js')).toBe(true);
    expect(shipsNativeFile('node-pty', 'prebuilds/win32-x64/conpty.node')).toBe(false);
    expect(shipsNativeFile('node-pty', 'third_party/conpty/x.dll')).toBe(false);
  });

  it('ships every file of a plain-JS helper', () => {
    expect(shipsNativeFile('bindings', 'bindings.js')).toBe(true);
  });
});

describe('signingOrder', () => {
  it('signs nested code inside-out and the app executable never on its own', () => {
    const order = signingOrder('/a/OmniFex.app', [
      '/a/OmniFex.app/Contents/MacOS/omnifexd',
      '/a/OmniFex.app/Contents/MacOS/OmniFex',
      '/a/OmniFex.app/Contents/Resources/app/node_modules/node-pty/build/Release/spawn-helper',
      '/a/OmniFex.app/Contents/Resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    ]);
    expect(order.at(-1)).toBe('/a/OmniFex.app');
    expect(order).not.toContain('/a/OmniFex.app/Contents/MacOS/OmniFex');
    const depth = (p: string) => p.split('/').length;
    const nested = order.slice(0, -1);
    expect(nested.map(depth)).toEqual([...nested.map(depth)].sort((x, y) => y - x));
  });
});
