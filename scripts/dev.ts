/**
 * Its own bundle id, so the dev app never shares LaunchServices state or notification settings with the installed app.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { APP_NAME, bundleLayout, infoPlist } from '../packaging/app-bundle';
import { assertSameNodeAbi } from '../packaging/node-runtime';

const root = path.resolve(import.meta.dirname, '..');
const DEV_SERVER = 'http://localhost:5173/';
const step = (cmd: string, args: string[]) => { execFileSync(cmd, args, { cwd: root, stdio: 'inherit' }); };

assertSameNodeAbi(process.version);
const version = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;

step('node', ['scripts/build-daemon.mjs']);
step('swift', ['build', '--package-path', 'macos']);
const binDir = execFileSync('swift', ['build', '--package-path', 'macos', '--show-bin-path'], { cwd: root, encoding: 'utf8' }).trim();

const app = path.join(root, 'out', 'dev', 'OmniFex Dev.app');
const L = bundleLayout(app);
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(L.macos, { recursive: true });
fs.mkdirSync(L.resources, { recursive: true });
fs.writeFileSync(path.join(L.contents, 'Info.plist'), infoPlist({ name: 'OmniFex Dev', bundleId: 'com.omnifex.app.dev', version }));
fs.copyFileSync(path.join(binDir, APP_NAME), L.executable);
fs.copyFileSync(path.join(root, 'icons', 'icon.icns'), path.join(L.resources, 'icon.icns'));
fs.copyFileSync(path.join(root, 'assets', 'greychrist_success.aiff'), path.join(L.resources, 'greychrist_success.aiff'));
// Ad-hoc: notifications need a sealed bundle, not a Developer ID.
step('codesign', ['--force', '--sign', '-', app]);
console.log(`[dev] built ${path.relative(root, app)}`);
if (process.argv.includes('--bundle-only')) process.exit(0);

const vite = spawn('npx', ['vite', '--config', 'vite.web.config.ts'], { cwd: root, stdio: 'inherit' });

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, 'localhost', () => { s.destroy(); resolve(true); });
    s.on('error', () => { resolve(false); });
  });
}
for (let i = 0; i < 120 && !(await portOpen(5173)); i++) await new Promise((r) => setTimeout(r, 250));

const child = spawn(L.executable, [], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    OMNIFEX_DEV_SERVER_URL: DEV_SERVER,
    OMNIFEX_NODE: process.execPath,
    OMNIFEX_DAEMON_SCRIPT: path.join(root, '.vite', 'build', 'omnifex-server.js'),
  },
});
child.on('exit', (code) => {
  vite.kill('SIGTERM');
  process.exit(code ?? 0);
});
