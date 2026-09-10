/**
 * Daemon configuration: `~/.omnifex/server.json` plus derived paths.
 *
 * Bind address policy, in order: what the file says; else the Tailscale
 * interface if one is up; else loopback. Never `0.0.0.0` unless written into
 * the file by hand — this daemon has no authentication beyond "you are on my
 * tailnet", and a default that listened on every interface would turn a
 * coffee-shop Wi-Fi into a session console.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const DEFAULT_PORT = 47700;

/** The slice of `os.networkInterfaces()` this module reads; injectable for tests. */
export type NetworkInterfaces = Record<
  string,
  Array<{ address: string; family: string | number; internal: boolean }> | undefined
>;

/**
 * Tailscale hands every node an IPv4 in 100.64.0.0/10 (the CGNAT range),
 * which nothing else on a Mac uses. Match the range, not the interface name:
 * it is `utunN` on macOS with N varying, `tailscale0` on Linux.
 */
export function detectTailscaleIp(interfaces: NetworkInterfaces): string | null {
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      const [o1, o2] = a.address.split('.').map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
    }
  }
  return null;
}

const FileSchema = z.looseObject({
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  webRoot: z.string().nullable().optional(),
  ringSize: z.number().int().positive().optional(),
  /** Milliseconds before an unanswered permission is denied; null = never. */
  permissionTimeoutMs: z.number().int().positive().nullable().optional(),
  /** Extra `rpc.invoke` channels to allow beyond the built-in list. */
  rpcAllow: z.array(z.string()).optional(),
  /** Channels to remove from the built-in allowlist. */
  rpcDeny: z.array(z.string()).optional(),
});

export interface ServerConfig {
  host: string;
  port: number;
  webRoot: string | null;
  ringSize: number;
  permissionTimeoutMs: number | null;
  rpcAllow: string[];
  rpcDeny: string[];
  /** `~/.omnifex` — the daemon's own state. */
  stateDir: string;
  sessionsDir: string;
  projectsFile: string;
  /** Where greychrist.db lives: Electron's userData, shared with the app. */
  userDataDir: string;
  /** Where this config was read from. */
  file: string;
}

export interface LoadServerConfigOptions {
  file?: string;
  interfaces?: NetworkInterfaces;
  env?: Record<string, string | undefined>;
}

export function defaultStateDir(env: Record<string, string | undefined> = process.env): string {
  return env.OMNIFEX_STATE_DIR ?? join(homedir(), '.omnifex');
}

export function loadServerConfig(opts: LoadServerConfigOptions = {}): ServerConfig {
  const env = opts.env ?? process.env;
  const stateDir = defaultStateDir(env);
  const file = opts.file ?? join(stateDir, 'server.json');

  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    // Absent is fine — defaults. Present-but-broken is not: a daemon that
    // shrugged and bound loopback on the default port would present from the
    // iPad as a network fault, which is the wrong place to go looking.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`server.json at ${file} is not valid JSON: ${(err as Error).message}`);
    }
  }

  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`server.json at ${file} is invalid: ${z.prettifyError(parsed.error)}`);
  }
  const f = parsed.data;

  const interfaces = opts.interfaces ?? (require('node:os') as typeof import('node:os')).networkInterfaces();
  const host = f.host ?? detectTailscaleIp(interfaces as NetworkInterfaces) ?? '127.0.0.1';

  return {
    host,
    port: f.port ?? DEFAULT_PORT,
    webRoot: f.webRoot ?? null,
    ringSize: f.ringSize ?? 5_000,
    permissionTimeoutMs: f.permissionTimeoutMs ?? null,
    rpcAllow: f.rpcAllow ?? [],
    rpcDeny: f.rpcDeny ?? [],
    stateDir,
    sessionsDir: join(stateDir, 'sessions'),
    projectsFile: join(stateDir, 'projects.json'),
    userDataDir: env.OMNIFEX_USER_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'OmniFex'),
    file,
  };
}
