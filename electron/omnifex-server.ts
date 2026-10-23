/**
 * Process entry for `omnifex-server`.
 *
 * Built with brain-mcp.js by `node scripts/build-daemon.mjs`. Run on Node 26:
 * in the app that is the bundled `Contents/MacOS/omnifexd` — the executable's
 * own name is what names the process — and in a checkout it is the system
 * `node`, which `scripts/omnifex-server` finds. One Node major everywhere, so
 * `better-sqlite3` and `node-pty` have a single ABI.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadServerConfig } from './remote/config';
import {
  HELP,
  installCommand,
  isProcessAlive,
  launchdAllowed,
  lifecycleEnv,
  parseCliArgs,
  readPid,
  removePidFile,
  statusCommand,
  stopCommand,
  uninstallCommand,
  writePidFile,
} from './remote/cli';
import { createDaemonControl } from './remote/daemon-control';
import { createRemoteLauncher, probeDaemonHealth } from './remote/launcher';
import { startDaemon } from './remote/daemon';
import type { RemoteServerLogger } from './remote/server';
import { createDevIdleWatch, isDevDaemon } from './remote/dev-instance';

/** How often the dev daemon asks whether anyone still needs it. */
const DEV_IDLE_CHECK_MS = 5_000;

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
 * builds, so `ensure --app-build` compares this instead to know the daemon
 * on the port is stale. Packaged builds pass no `--app-build`, so it is not
 * compared there.
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
  const dev = args.flags.dev === true;

  /**
   * ensure / restart / stop act on an instance: the real one, or with `--dev`
   * the dev one. Their log goes to stderr so stdout carries only the answer.
   */
  const lifecycle = () => {
    const env = lifecycleEnv(process.env, { dev });
    const instanceConfig = () => loadServerConfig({ env });
    const log = (message: string, meta?: Record<string, unknown>) => {
      process.stderr.write(`[lifecycle] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`);
    };
    const control = createDaemonControl({
      invocation: { execPath: process.execPath, script: __filename },
      env,
      allowLaunchd: launchdAllowed(env, { dev }),
      // The dev daemon belongs to the dev app: same process group (the app
      // runs this CLI inside its own group), so Ctrl-C in its terminal
      // reaches it, and the app stops it on quit.
      detached: !dev,
      log,
    });
    const flag = (name: string) => {
      const value = args.flags[name];
      return typeof value === 'string' ? value : undefined;
    };
    const launcher = createRemoteLauncher({
      config: instanceConfig,
      appVersion: flag('app-version') ?? version,
      appBuild: flag('app-build'),
      appScript: __filename,
      probe: probeDaemonHealth,
      spawn: (c) => control.spawn(c),
      stop: (c) => control.stop(c),
      log,
    });
    return { control, launcher, config: instanceConfig() };
  };

  switch (args.command) {
    case 'config':
      out(JSON.stringify({ version, ...config }, null, 2));
      return 0;

    case 'status':
      return statusCommand(config, args.flags.json === true, out);

    case 'stop': {
      const { control, config: instance } = lifecycle();
      return stopCommand(instance, control, {
        readPid,
        isAlive: isProcessAlive,
        removePidFile,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        out,
      });
    }

    case 'ensure':
    case 'restart': {
      const { launcher } = lifecycle();
      const result = args.command === 'ensure' ? await launcher.ensure() : await launcher.restart();
      // One JSON line, last on stdout: what the app parses.
      out(JSON.stringify(result));
      return 0;
    }

    case 'install':
      return installCommand({ execPath: process.execPath, script: __filename }, out);

    case 'uninstall':
      return uninstallCommand(out);

    case 'start': {
      const log = createLogger(process.env.OMNIFEX_LOG_LEVEL === 'debug' || args.flags.debug === true ? 'debug' : 'info');
      process.on('uncaughtException', (err) => log.error('uncaught exception', { error: err.stack ?? String(err) }));
      process.on('unhandledRejection', (err) => log.error('unhandled rejection', { error: String(err) }));

      const daemon = await startDaemon({ config, version, build: readBuildStamp(), script: __filename, log });
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

      // A dev daemon belongs to the `npm start` that spawned it. That app
      // SIGTERMs it on quit and shares a process group with it, so Ctrl-C
      // reaches it too — this is the backstop for the app being killed
      // outright, so a stale dev daemon never sits on the port running an
      // hour-old build. See remote/dev-instance.ts.
      if (isDevDaemon(process.env)) {
        const startedAt = Date.now();
        const idle = createDevIdleWatch({
          clients: () => daemon.status().clients,
          inFlight: () => daemon.status().inFlight,
          everConnected: () => daemon.status().everConnected,
          startedAt,
        });
        const timer = setInterval(() => {
          if (idle.check(Date.now())) shutdown('idle');
        }, DEV_IDLE_CHECK_MS);
        timer.unref?.();
      }
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
