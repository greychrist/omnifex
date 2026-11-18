/**
 * The dev instance: `npm start` gets its own daemon, beside the installed
 * app's rather than instead of it.
 *
 * A dev build and the installed app share `~/.omnifex` and port 47700, so the
 * one daemon on that port held every live CLI process the user had open —
 * belonging to the app they actually work in. Launching the dev app used to
 * SIGTERM it (see remote-launcher.ts, which no longer lets it), and even once
 * it could not, dev drove those same live sessions: killing, interrupting and
 * prompting real conversations from a build under test.
 *
 * So dev moves: its own state dir, its own port, and a marker that follows the
 * daemon it spawns. What it deliberately does NOT move is the database — the
 * dev app still sees the real accounts, projects and history, which is most of
 * why one runs it. That sharing is what `periodicWorkGate` is for.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Env = Record<string, string | undefined>;

/** `~/.omnifex-dev`, beside the real `~/.omnifex`. */
export const DEV_STATE_DIR_NAME = '.omnifex-dev';
/** One above the real 47700, so both daemons can listen at once. */
export const DEV_PORT = 47701;
/** Set on the dev app and inherited by the daemon it spawns. */
export const DEV_DAEMON_ENV = 'OMNIFEX_DEV_DAEMON';

/**
 * Whether this process should run as the dev instance. The installed app
 * never does — it is the product, and it owns the real port. `npm start` can
 * opt out with `OMNIFEX_DEV_INSTANCE=0` to drive the real daemon on purpose
 * (debugging a live session, reproducing something against real state).
 */
export function shouldUseDevInstance(opts: { packaged: boolean; env: Env }): boolean {
  if (opts.packaged) return false;
  if (opts.env.OMNIFEX_DEV_INSTANCE === '0') return false;
  return true;
}

/**
 * The dev instance as an environment overlay, resolved against `env` but
 * never written into it.
 *
 * It used to be written into `process.env` directly, which made the spawned
 * daemon inherit it for free — and everything else the app spawns inherit it
 * too. A CLI session, an agent, a Brain extraction and any shell command run
 * inside a session all carried `OMNIFEX_PORT=47701`, so `npm test` from a
 * terminal inside a dev session failed remote-config's "the file overrides
 * the port" case against a port the test never set. Worse, launching the
 * PACKAGED app from a dev session pointed the real product at the dev daemon:
 * `shouldUseDevInstance` correctly says no for a packaged build, but
 * `loadServerConfig()` reads the environment regardless.
 *
 * So the overlay is returned and handed to the two places that want it —
 * `loadServerConfig()` in main, and the environment `daemon-control` gives
 * the daemon it spawns. The daemon still learns where the instance lives the
 * same way it always did, from its own environment; what changed is that
 * nothing else does.
 *
 * An explicit value in `env` is kept — a throwaway `OMNIFEX_STATE_DIR` for a
 * smoke run still wins. Empty counts as unset.
 */
export function devInstanceEnv(env: Env, home: string = homedir()): Env {
  return {
    OMNIFEX_STATE_DIR: env.OMNIFEX_STATE_DIR || join(home, DEV_STATE_DIR_NAME),
    OMNIFEX_PORT: env.OMNIFEX_PORT || String(DEV_PORT),
    [DEV_DAEMON_ENV]: env[DEV_DAEMON_ENV] || '1',
  };
}

/** Whether this process is (or was spawned by) the dev instance. */
export function isDevDaemon(env: Env = process.env): boolean {
  return env[DEV_DAEMON_ENV] === '1';
}

/**
 * The `enabled` gate for `startPeriodicWork` in a daemon: closed for a dev
 * daemon, absent (meaning "always") for the real one.
 *
 * The dev daemon shares the database, and the cost backfill, archive prune,
 * free-page reclaim and Brain sweep/drain are not idempotent with respect to
 * money — `brain_spend` is append-only and `recoverOrphans()` re-queues rows
 * the other process is mid-extraction on, so a second sweeper pays twice for
 * one distillation. Maintenance stays with the installed pair; a dev daemon
 * is a fixture. Nothing is lost while only dev is running, it is just
 * deferred to the next time the real app is up.
 */
export function periodicWorkGate(env: Env = process.env): (() => boolean) | undefined {
  return isDevDaemon(env) ? () => false : undefined;
}
