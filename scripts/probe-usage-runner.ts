/**
 * Capture one live `/usage` render through the shipped usage runner.
 *
 * The runner itself does the work — startup interstitials, ready markers,
 * the render-complete wait, stripAnsi, the parser and its drift warnings — so
 * this probe cannot drift from what the app sees. The copy it replaced
 * re-implemented the startup phase, fell behind the runner, and by 2.1.306
 * captured nothing at all.
 *
 * Usage:
 *   node --experimental-strip-types --import ./scripts/lib/register-ts.mjs \
 *        scripts/probe-usage-runner.ts ~/.claude-personal [Personal]
 *
 * The second argument is the scratch-cwd key; it defaults to the config
 * dir's suffix (`.claude-work` → `Work`), which is the folder the app already
 * uses under `<userData>/usage-cwd/`, so a normal run trusts nothing new.
 *
 * Writes /tmp/usage-probe/: `raw.ansi` (the pty bytes, fixture-ready),
 * `stripped.txt` (what the parser read) and `parsed.json`. Records nothing:
 * the rate-limits store is a stub.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as ptySpawn } from 'node-pty';
import { createUsageRunnerService, type FakePty, type PtySpawner, type UsageRunnerDeps } from '../electron/services/usage-runner';
import { collectUsageDriftWarnings } from '../electron/services/usage-runner/parser';

const configDirArg = process.argv[2];
if (!configDirArg) {
  console.error('usage: probe-usage-runner.ts <configDir> [scratchKey]');
  process.exit(1);
}
const configDir = path.resolve(configDirArg.replace(/^~(?=\/|$)/, os.homedir()));
const suffix = path.basename(configDir).replace(/^\.claude-?/, '');
const accountKey = process.argv[3] ?? (suffix ? suffix[0].toUpperCase() + suffix.slice(1) : 'Default');

const binary = [`${os.homedir()}/.local/bin/claude`, '/usr/local/bin/claude', '/opt/homebrew/bin/claude']
  .find((p) => fs.existsSync(p));
if (!binary) {
  console.error('Cannot find the claude binary');
  process.exit(1);
}

// Tee every pty byte so the raw ANSI stream can be saved as a fixture.
let rawAnsi = '';
const spawnPty: PtySpawner = (command, args, opts) => {
  const pty = ptySpawn(command, args, opts);
  const fake: FakePty = {
    write: (d) => { pty.write(d); },
    kill: () => { pty.kill(); },
    onData: (cb) => { pty.onData((d) => { rawAnsi += d; cb(d); }); },
    onExit: (cb) => { pty.onExit((e) => { cb({ exitCode: e.exitCode }); }); },
  };
  return fake;
};

const runner = createUsageRunnerService({
  accounts: { listAccounts: () => [{ name: accountKey, config_dir: configDir, cli_path: null }] },
  rateLimits: { recordUtilization: () => {} },
  logging: {
    writeBatch: (entries: { level: string; message: string; metadata?: string }[]) => {
      for (const e of entries) {
        // The capture itself is written to disk below; keep stderr readable.
        const meta = e.message.startsWith('usage capture') ? '' : (e.metadata ?? '');
        console.error(`[runner ${e.level}] ${e.message} ${meta}`);
      }
    },
  },
  spawnPty,
  findClaudeBinary: () => binary,
  userDataDir: path.join(os.homedir(), 'Library', 'Application Support', 'OmniFex'),
} as unknown as UsageRunnerDeps);

console.error(`[probe] ${binary} · CLAUDE_CONFIG_DIR=${configDir} · scratch key ${accountKey}`);
const result = await runner.run(accountKey);

const outDir = '/tmp/usage-probe';
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'raw.ansi'), rawAnsi);
fs.writeFileSync(path.join(outDir, 'stripped.txt'), result.raw ?? '');
fs.writeFileSync(path.join(outDir, 'parsed.json'), JSON.stringify(result, null, 2));

console.error(`\n[probe] wrote ${outDir}/raw.ansi (${rawAnsi.length} bytes), stripped.txt, parsed.json`);
if (result.ok) {
  const d = result.parsed;
  console.error(`[probe] ok${d.stale ? ' (stale render)' : ''} · windows ${d.windows.map((w) => `${w.label}=${w.pct_used}%`).join(' ') || 'none'}`);
  console.error(`[probe] contributing ${d.contributing.length} · skills ${d.skills.rows.length} · subagents ${d.subagents.rows.length} · plugins ${d.plugins.rows.length} · mcp ${d.mcp_servers.rows.length} · loops ${d.loops.rows.length}`);
  const drift = collectUsageDriftWarnings(result.raw);
  if (drift.length > 0) console.error(`[probe] drift: ${drift.join('; ')}`);
} else {
  console.error(`[probe] FAILED: ${result.error}`);
}
// node-pty keeps the loop alive after the runner's delayed kill.
setTimeout(() => process.exit(result.ok ? 0 : 1), 800);
