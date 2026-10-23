/**
 * The Node the app bundles as `Contents/MacOS/omnifexd`.
 *
 * Owning this version is the reason the Electron shell was replaced: Electron
 * 41 bundled Node 24.18.0 and stopped receiving releases, so the 2026-10-21
 * Node security release (10 CVEs, a Brotli RCE among them) had no way into
 * the app. Bumping this constant and releasing is now the whole fix.
 *
 * The official darwin-arm64 binary, checked against nodejs.org's
 * SHASUMS256.txt before it goes anywhere near the bundle.
 */

export const BUNDLED_NODE_VERSION = '26.12.1';

export interface NodeDist {
  tarball: string;
  shasums: string;
  fileName: string;
  /** Path of the `node` binary inside the tarball. */
  binaryInTarball: string;
}

export function nodeDist(version: string = BUNDLED_NODE_VERSION, arch = 'arm64'): NodeDist {
  const dir = `node-v${version}-darwin-${arch}`;
  const fileName = `${dir}.tar.gz`;
  return {
    tarball: `https://nodejs.org/dist/v${version}/${fileName}`,
    shasums: `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
    fileName,
    binaryInTarball: `${dir}/bin/node`,
  };
}

/** The hex digest SHASUMS256.txt lists for exactly `fileName`, or null. */
export function expectedSha256(shasums: string, fileName: string): string | null {
  for (const line of shasums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (m?.[2] === fileName) return m[1];
  }
  return null;
}

/**
 * `better-sqlite3` and `node-pty` are compiled by `npm install` against the
 * node running it, and the package step copies those builds. They load in
 * the bundled node only if both are the same major — one ABI. Checked before
 * anything is copied, because the failure otherwise is the packaged daemon
 * dying on its first `require`.
 */
export function assertSameNodeAbi(buildNode: string, bundled: string = BUNDLED_NODE_VERSION): void {
  const major = (v: string) => Number(v.replace(/^v/, '').split('.')[0]);
  if (major(buildNode) !== major(bundled)) {
    throw new Error(
      `packaging: native modules were built by node ${buildNode}, but the app bundles Node ${major(bundled)} ` +
        `(${bundled}). Switch to Node ${major(bundled)} (\`nvm use\`, see .nvmrc) and run \`npm rebuild\`.`,
    );
  }
}
