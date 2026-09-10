/**
 * Process entry for `omnifex-server`.
 *
 * Built by Forge alongside main.js and brain-mcp.js (see forge.config.ts), and
 * on its own by `node scripts/build-daemon.mjs`. Always run as the Electron
 * binary with ELECTRON_RUN_AS_NODE=1 — `scripts/omnifex-server` does that.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadServerConfig } from './remote/config';
import {
  HELP,
  installCommand,
  parseCliArgs,
  removePidFile,
  statusCommand,
  stopDaemon,
  uninstallCommand,
  writePidFile,
} from './remote/cli';
import { startDaemon } from './remote/daemon';
import type { RemoteServerLogger } from './remote/server';

function readVersion(): string {
  // Beside the bundle in a packaged app (app.asar/package.json) and two
  // levels up from .vite/build in the repo.
  for (const candidate of [join(__dirname, '..', '..', 'package.json'), join(__dirname, '..', 'package.json')]) {
    try {
      const v = (JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string }).version;
      if (v) return v;
    } catch {
      // try the next
    }
  }
  return '0.0.0';
}

/**
 * This bundle's mtime. In a dev checkout the version never moves between
 * builds, so the Electron launcher compares this instead to know the daemon
 * on the port is stale. Packaged builds do not compare it (see main.ts).
 */
function readBuildStamp(): string | undefined {
  try {
    return String(Math.floor(statSync(__filename).mtimeMs));
  } catch {
    return undefined;
  }
}

/** One line per event, JSON-ish, to stdout — launchd sends it to the log file. */
function createLogger(level: 'debug' | 'info'): RemoteServerLogger {
  const line = (lvl: string, message: string, meta?: Record<string, unknown>) => {
    const out = `${new Date().toISOString()} ${lvl.padEnd(5)} ${message}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(out);
  };
  return {
    debug: (m, meta) => { if (level === 'debug') line('debug', m, meta); },
    info: (m, meta) => line('info', m, meta),
    warn: (m, meta) => line('warn', m, meta),
    error: (m, meta) => line('error', m, meta),
  };
}

async function main(argv: string[]): Promise<number> {
  const args = parseCliArgs(argv);
  const out = (s: string) => { process.stdout.write(`${s}\n`); };
  const version = readVersion();

  if (args.command === 'help') {
    if (args.unknown) out(`unknown command: ${args.unknown}\n`);
    out(HELP);
    return args.unknown ? 2 : 0;
  }

  const config = loadServerConfig();

  switch (args.command) {
    case 'config':
      out(JSON.stringify({ version, ...config }, null, 2));
      return 0;

    case 'status':
      return statusCommand(config, args.flags.json === true, out);

    case 'stop':
      return stopDaemon(config, out);

    case 'install':
      return installCommand({ execPath: process.execPath, script: __filename }, out);

    case 'uninstall':
      return uninstallCommand(out);

    case 'start': {
      const log = createLogger(process.env.OMNIFEX_LOG_LEVEL === 'debug' || args.flags.debug === true ? 'debug' : 'info');
      process.on('uncaughtException', (err) => log.error('uncaught exception', { error: err.stack ?? String(err) }));
      process.on('unhandledRejection', (err) => log.error('unhandled rejection', { error: String(err) }));

      const daemon = await startDaemon({ config, version, build: readBuildStamp(), log });
      writePidFile(config);

      let closing = false;
      const shutdown = (signal: string) => {
        if (closing) return;
        closing = true;
        log.info('shutting down', { signal });
        daemon
          .close()
          .catch((err: unknown) => log.error('close failed', { error: String(err) }))
          .finally(() => {
            removePidFile(config);
            process.exit(0);
          });
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
      // Foreground forever; launchd owns the lifecycle.
      return new Promise<number>(() => {});
    }
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => { if (code !== 0) process.exit(code); },
  (err: unknown) => {
    process.stderr.write(`omnifex-server: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
