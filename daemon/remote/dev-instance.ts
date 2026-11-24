// Dev shares the database on purpose, never the state dir or port: the installed app's daemon holds the user's live sessions.
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Env = Record<string, string | undefined>;

export const DEV_STATE_DIR_NAME = '.omnifex-dev';
export const DEV_PORT = 47701;
export const DEV_DAEMON_ENV = 'OMNIFEX_DEV_DAEMON';

/**
 * Returned, never written into `process.env`: everything spawned would inherit it, and a packaged app
 * launched from a dev session would talk to the dev daemon. Explicit values in `env` win; empty is unset.
 */
export function devInstanceEnv(env: Env, home: string = homedir()): Env {
  return {
    OMNIFEX_STATE_DIR: env.OMNIFEX_STATE_DIR || join(home, DEV_STATE_DIR_NAME),
    OMNIFEX_PORT: env.OMNIFEX_PORT || String(DEV_PORT),
    [DEV_DAEMON_ENV]: env[DEV_DAEMON_ENV] || '1',
  };
}

export function isDevDaemon(env: Env = process.env): boolean {
  return env[DEV_DAEMON_ENV] === '1';
}

/** Closed for a dev daemon: it shares the DB, and a second sweeper pays twice (`brain_spend`). */
export function periodicWorkGate(env: Env = process.env): (() => boolean) | undefined {
  return isDevDaemon(env) ? () => false : undefined;
}
