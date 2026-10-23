import { describe, expect, it } from 'vitest';

import { BUNDLED_NODE_VERSION, assertSameNodeAbi, expectedSha256, nodeDist } from '../../packaging/node-runtime';

describe('bundled node runtime', () => {
  it('is a patched 26.x', () => {
    // 26.12.1 carries the 2026-10-21 security release (Brotli RCE and nine
    // others). Anything older than that in the 26 line must not ship.
    const [major, minor, patch] = BUNDLED_NODE_VERSION.split('.').map(Number);
    expect(major).toBe(26);
    expect(minor * 1000 + patch).toBeGreaterThanOrEqual(12 * 1000 + 1);
  });

  it('names the official darwin-arm64 tarball and its checksum list', () => {
    expect(nodeDist('26.12.1')).toEqual({
      tarball: 'https://nodejs.org/dist/v26.12.1/node-v26.12.1-darwin-arm64.tar.gz',
      shasums: 'https://nodejs.org/dist/v26.12.1/SHASUMS256.txt',
      fileName: 'node-v26.12.1-darwin-arm64.tar.gz',
      binaryInTarball: 'node-v26.12.1-darwin-arm64/bin/node',
    });
  });

  it('finds a file\'s hash in SHASUMS256.txt, and nothing for a near miss', () => {
    const list = [
      `${'a'.repeat(64)}  node-v26.12.1-darwin-arm64.tar.gz`,
      `${'b'.repeat(64)}  node-v26.12.1-darwin-arm64.tar.xz`,
    ].join('\n');
    expect(expectedSha256(list, 'node-v26.12.1-darwin-arm64.tar.gz')).toBe('a'.repeat(64));
    expect(expectedSha256(list, 'node-v26.12.1-darwin-arm64.tar')).toBeNull();
  });

  // The native modules are built by `npm install` for the node running it.
  // They load in the bundled node only when both share a major (one ABI).
  it('refuses to package when the build node and the bundled node differ in major', () => {
    expect(() => assertSameNodeAbi('v26.3.0', '26.12.1')).not.toThrow();
    expect(() => assertSameNodeAbi('v22.22.3', '26.12.1')).toThrow(/Node 26/);
  });
});
