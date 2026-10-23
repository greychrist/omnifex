/**
 * Build `out/OmniFex-darwin-arm64/OmniFex.app` — and with `--make`, the
 * release artifacts the updater and the release skill expect:
 *
 *   out/make/zip/darwin/arm64/OmniFex-darwin-arm64-<v>.zip
 *   out/make/OmniFex-<v>-arm64.dmg
 *
 * Run through `npm run package` / `npm run make` (node with the repo's TS
 * resolver). `OMNIFEX_NOTARIZE=1` notarizes and staples the app and the DMG;
 * without it the app is signed (Developer ID when the keychain has one,
 * ad-hoc otherwise) and never leaves the machine. `APPLE_SIGNING_IDENTITY`
 * picks the certificate when several are installed.
 *
 * The layout is packaging/app-bundle.ts; the Node it bundles is
 * packaging/node-runtime.ts.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  APP_NAME,
  BUNDLE_ID,
  JS_EXTERNAL_MODULES,
  NATIVE_MODULES,
  bundleLayout,
  infoPlist,
  isMachO,
  shipsNativeFile,
  signingOrder,
} from '../packaging/app-bundle';
import { collectModuleTree } from '../packaging/module-tree';
import { BUNDLED_NODE_VERSION, assertSameNodeAbi, expectedSha256, nodeDist } from '../packaging/node-runtime';
import { entitlementsFor, osxNotarizeConfig } from '../signing';
import { developerIdIdentities, notarizeApp, notarizeDmg, pickSigningIdentity } from '../signing/dmg';

const root = path.resolve(import.meta.dirname, '..');
const make = process.argv.includes('--make');
const log = (m: string) => { console.log(`[package] ${m}`); };

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  return execFileSync(cmd, args, { cwd: opts.cwd ?? root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function step(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
}

function copy(from: string, to: string, filter?: (src: string) => boolean): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, ...(filter ? { filter } : {}) });
}

// ---------------------------------------------------------------------------

assertSameNodeAbi(process.version);
const version = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
log(`OmniFex ${version}, Node ${BUNDLED_NODE_VERSION}`);

// 1. The three things that get built: renderer, daemon bundles, Swift app.
step('npm', ['run', 'build:web']);
step('node', ['scripts/build-daemon.mjs']);
step('swift', ['build', '-c', 'release', '--arch', 'arm64', '--package-path', 'macos']);
const swiftBin = path.join(run('swift', ['build', '-c', 'release', '--arch', 'arm64', '--package-path', 'macos', '--show-bin-path']).trim(), APP_NAME);

// 2. Node: the official binary, verified against nodejs.org's checksums,
//    cached by version so a rebuild does not download it again.
async function bundledNode(): Promise<string> {
  const dist = nodeDist();
  const cache = path.join(root, '.cache', 'node', BUNDLED_NODE_VERSION);
  const binary = path.join(cache, dist.binaryInTarball);
  if (fs.existsSync(binary)) return binary;
  fs.mkdirSync(cache, { recursive: true });
  log(`downloading ${dist.tarball}`);
  const [tarball, shasums] = await Promise.all([
    fetch(dist.tarball).then(async (r) => {
      if (!r.ok) throw new Error(`${dist.tarball}: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    }),
    fetch(dist.shasums).then(async (r) => {
      if (!r.ok) throw new Error(`${dist.shasums}: HTTP ${r.status}`);
      return r.text();
    }),
  ]);
  const want = expectedSha256(shasums, dist.fileName);
  const got = createHash('sha256').update(tarball).digest('hex');
  if (!want || want !== got) throw new Error(`${dist.fileName}: checksum ${got} does not match SHASUMS256.txt (${want ?? 'not listed'})`);
  const tarPath = path.join(cache, dist.fileName);
  fs.writeFileSync(tarPath, tarball);
  run('tar', ['-xzf', tarPath, '-C', cache, dist.binaryInTarball]);
  fs.rmSync(tarPath);
  return binary;
}
const node = await bundledNode();

// 3. Assemble.
const outDir = path.join(root, 'out', 'OmniFex-darwin-arm64');
const app = path.join(outDir, `${APP_NAME}.app`);
const L = bundleLayout(app);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(L.macos, { recursive: true });
fs.mkdirSync(L.build, { recursive: true });

fs.writeFileSync(path.join(L.contents, 'Info.plist'), infoPlist({ name: APP_NAME, bundleId: BUNDLE_ID, version }));
fs.copyFileSync(swiftBin, L.executable);
fs.copyFileSync(node, L.node);
fs.chmodSync(L.node, 0o755);
fs.copyFileSync(path.join(root, 'icons', 'icon.icns'), path.join(L.resources, 'icon.icns'));
fs.copyFileSync(path.join(root, 'assets', 'greychrist_success.aiff'), path.join(L.resources, 'greychrist_success.aiff'));

// The daemon reads its version from here (omnifex-server.ts readVersion), and
// `ensure` compares it with the app's to know an outdated daemon.
fs.writeFileSync(path.join(L.appRoot, 'package.json'), `${JSON.stringify({ name: 'omnifex', version, private: true }, null, 2)}\n`);
for (const f of ['omnifex-server.js', 'brain-mcp.js']) fs.copyFileSync(path.join(root, '.vite', 'build', f), path.join(L.build, f));

for (const mod of NATIVE_MODULES) {
  const src = path.join(root, 'node_modules', mod);
  copy(src, path.join(L.nodeModules, mod), (p) => {
    const rel = path.relative(src, p);
    return rel === '' || fs.statSync(p).isDirectory() || shipsNativeFile(mod, rel);
  });
}
for (const rel of collectModuleTree(JS_EXTERNAL_MODULES, root)) {
  copy(path.join(root, rel), path.join(L.appRoot, rel));
}
copy(path.join(root, 'dist-web'), L.webRoot);
copy(path.join(root, 'omnifex-mod'), L.mod);
// Directories the native filter walked into but shipped nothing from.
run('find', [L.nodeModules, '-type', 'd', '-empty', '-delete']);

// 4. Smoke: the bundled node loads both addons from the bundle and runs the
//    daemon's CLI. Before signing, so a wrong ABI fails here, loudly.
log(run(L.node, ['-e', "new (require('better-sqlite3'))(':memory:').prepare('select 1').get(); require('node-pty'); process.stdout.write('native modules load')"], { cwd: L.appRoot }).trim());
run(L.node, [path.join(L.build, 'omnifex-server.js'), 'help']);

// 5. Sign: nested code inside-out, then the bundle, all hardened runtime.
function machOFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...machOFiles(p));
    else {
      const fd = fs.openSync(p, 'r');
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      if (isMachO(head)) out.push(p);
    }
  }
  return out;
}
const notarize = osxNotarizeConfig();
const identities = developerIdIdentities(run('security', ['find-identity', '-v', '-p', 'codesigning']));
const identity = identities.length || process.env.APPLE_SIGNING_IDENTITY || notarize
  ? pickSigningIdentity(identities, process.env.APPLE_SIGNING_IDENTITY)
  : '-';
log(`signing with ${identity === '-' ? 'an ad-hoc signature (no Developer ID in the keychain)' : `"${identity}"`}`);
for (const target of signingOrder(app, machOFiles(app))) {
  const ent = entitlementsFor(target);
  run('codesign', [
    '--force', '--options', 'runtime',
    ...(identity === '-' ? [] : ['--timestamp']),
    ...(ent ? ['--entitlements', ent] : []),
    '--sign', identity, target,
  ]);
}
run('codesign', ['--verify', '--deep', '--strict', app]);
log(`built ${path.relative(root, app)}`);

if (!make) process.exit(0);

// 6. Release artifacts. The zip is what the updater downloads — the Electron
//    app's included, which is how its one other user moves to this one — and
//    is made from the stapled app.
const run2 = (cmd: string, args: string[]) => run(cmd, args);
if (notarize) {
  await notarizeApp(app, path.join(os.tmpdir(), `omnifex-notarize-${version}.zip`), notarize, { run: run2, log });
}
const zipDir = path.join(root, 'out', 'make', 'zip', 'darwin', 'arm64');
fs.mkdirSync(zipDir, { recursive: true });
const zip = path.join(zipDir, `OmniFex-darwin-arm64-${version}.zip`);
fs.rmSync(zip, { force: true });
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
log(`built ${path.relative(root, zip)}`);

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-dmg-'));
run('ditto', [app, path.join(staging, `${APP_NAME}.app`)]);
fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
const dmg = path.join(root, 'out', 'make', `OmniFex-${version}-arm64.dmg`);
fs.rmSync(dmg, { force: true });
run('hdiutil', ['create', '-volname', APP_NAME, '-srcfolder', staging, '-ov', '-format', 'ULFO', dmg]);
fs.rmSync(staging, { recursive: true, force: true });
if (notarize) {
  await notarizeDmg(dmg, { keychainProfile: notarize.keychainProfile, identity: process.env.APPLE_SIGNING_IDENTITY }, { run: run2, log });
}
log(`built ${path.relative(root, dmg)}`);
