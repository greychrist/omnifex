/** Bumping this and releasing is how a Node security fix reaches the app. */
export const BUNDLED_NODE_VERSION = '26.13.1';

export interface NodeDist {
  tarball: string;
  shasums: string;
  fileName: string;
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

export function expectedSha256(shasums: string, fileName: string): string | null {
  for (const line of shasums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (m?.[2] === fileName) return m[1];
  }
  return null;
}

/**
 * The native modules are compiled against the node running `npm install` and load in the bundled
 * node only on the same major; otherwise the packaged daemon dies on its first `require`.
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
