// One-off probe: spawn claude in a PTY exactly the way the runner does,
// send /usage, capture raw bytes, then ANSI-strip and run the parser.
// Prints both raw and parsed so we can see why the live capture diverges
// from the fixture-based tests.
//
// Usage:
//   CLAUDE_CONFIG_DIR=~/.claude-personal node scripts/probe-usage-runner.mjs
//   CLAUDE_CONFIG_DIR=~/.claude-work     node scripts/probe-usage-runner.mjs

import { spawn as ptySpawn } from 'node-pty';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const configDir = process.env.CLAUDE_CONFIG_DIR;
if (!configDir) {
  console.error('Set CLAUDE_CONFIG_DIR before running.');
  process.exit(1);
}

const candidates = [
  `${process.env.HOME}/.local/bin/claude`,
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
];
const binary = candidates.find((p) => fs.existsSync(p));
if (!binary) {
  console.error('Cannot find claude binary');
  process.exit(1);
}

console.error(`[probe] spawning ${binary} with CLAUDE_CONFIG_DIR=${configDir}`);

const pty = ptySpawn(binary, [], {
  cwd: os.homedir(),
  env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  cols: 200,
  rows: 60,
});

let buffer = '';
let lastByteAt = Date.now();
pty.onData((chunk) => {
  buffer += chunk;
  lastByteAt = Date.now();
});

const SETTLE_MS = 750;
const USAGE_QUIET_MS = 1500;
const HARD_TIMEOUT_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hardDeadline = Date.now() + HARD_TIMEOUT_MS;

// Phase 1: navigate past startup (trust dialog → welcome). Trust default
// is highlighted "Yes" — pressing Enter confirms. Welcome screen footer
// "? for shortcuts" is our ready signal.
console.error('[probe] phase 1: waiting for welcome footer marker');
const READY = 'for shortcuts';
const TRUST = 'trust this folder';
const stripForCheck = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ' ')
  .replace(/\x1b[NOPQ\\\^_]/g, '');
let trustConfirmed = false;
while (Date.now() < hardDeadline) {
  const stripped = stripForCheck(buffer);
  const ready = stripped.includes(READY);
  const quiet = Date.now() - lastByteAt >= SETTLE_MS;
  if (ready && quiet) break;
  if (!trustConfirmed && stripped.includes(TRUST)) {
    console.error('[probe] saw trust dialog, sending Enter');
    pty.write('\r');
    trustConfirmed = true;
  }
  await sleep(50);
}
console.error(`[probe] phase 1 done at ${buffer.length} bytes`);

// Phase 2: send /usage
const beforeUsage = buffer.length;
pty.write('/usage\r');
console.error('[probe] phase 2: sent /usage');

// Phase 3: wait for /usage rendering to settle
let lastSeenLen = beforeUsage;
let stableSince = Date.now();
while (Date.now() < hardDeadline) {
  if (buffer.length !== lastSeenLen) {
    lastSeenLen = buffer.length;
    stableSince = Date.now();
  } else if (buffer.length > beforeUsage && Date.now() - stableSince >= USAGE_QUIET_MS) {
    break;
  }
  await sleep(20);
}
console.error(`[probe] phase 3 done at ${buffer.length} bytes (post-/usage delta: ${buffer.length - beforeUsage})`);

try { pty.write('/quit\r'); } catch {}
setTimeout(() => { try { pty.kill(); } catch {} }, 500);

// Save raw and stripped buffers + parser result
const outDir = '/tmp/usage-probe';
fs.mkdirSync(outDir, { recursive: true });

const rawAll = buffer;
const rawPostUsage = buffer.slice(beforeUsage);
fs.writeFileSync(path.join(outDir, 'raw-all.bin'), rawAll);
fs.writeFileSync(path.join(outDir, 'raw-post-usage.bin'), rawPostUsage);

// Mirror production stripAnsi: classify CSI commands so cursor-down becomes
// a newline (panel rows stay separate), cursor-forward becomes a space
// (word boundaries), color codes go away, others go away.
const CSI_FULL = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const BARE_ESC = /\x1b[NOPQ\\\^_]/g;
const stripped = rawPostUsage
  .replace(OSC, '')
  .replace(BARE_ESC, '')
  .replace(CSI_FULL, (seq) => {
    const cmd = seq[seq.length - 1];
    if (cmd === 'B' || cmd === 'E') return '\n';
    if (cmd === 'C') return ' ';
    return '';
  })
  .split('\n')
  .map((line) => line.replace(/ {2,}/g, ' '))
  .join('\n');
fs.writeFileSync(path.join(outDir, 'stripped-post-usage.txt'), stripped);

console.error(`\n[probe] wrote files to ${outDir}/`);
console.error(`        raw-all.bin            (${rawAll.length} bytes)`);
console.error(`        raw-post-usage.bin     (${rawPostUsage.length} bytes)`);
console.error(`        stripped-post-usage.txt (${stripped.length} bytes)`);
console.error(`\n[probe] === stripped output ===`);
console.error(stripped);
console.error(`[probe] === end stripped ===`);

setTimeout(() => process.exit(0), 600);
