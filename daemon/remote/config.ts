// Never default to `0.0.0.0`: there is no authentication beyond the tailnet.
import { readFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const DEFAULT_PORT = 47700;

export type NetworkInterfaces = Record<
  string,
  { address: string; family: string | number; internal: boolean }[] | undefined
>;

/** Match the CGNAT range, not the interface name: `utunN` varies. */
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
  permissionTimeoutMs: z.number().int().positive().nullable().optional(),
  rpcAllow: z.array(z.string()).optional(),
  rpcDeny: z.array(z.string()).optional(),
});

export interface ServerConfig {
  host: string;
  hostIsFallback?: boolean;
  port: number;
  webRoot: string | null;
  ringSize: number;
  permissionTimeoutMs: number | null;
  rpcAllow: string[];
  rpcDeny: string[];
  stateDir: string;
  sessionsDir: string;
  projectsFile: string;
  userDataDir: string;
  file: string;
}

/** Unparseable is ignored, not fatal: a shell-profile typo must not stop the daemon. */
function portFromEnv(env: Record<string, string | undefined>): number | null {
  const n = Number(env.OMNIFEX_PORT);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export interface LoadServerConfigOptions {
  file?: string;
  interfaces?: NetworkInterfaces;
  env?: Record<string, string | undefined>;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** Loopback too, where the Mac app loads from (see `localUrl`); a wildcard bind already covers it. */
export function extraListenHosts(host: string): string[] {
  if (isLoopbackHost(host) || host === '0.0.0.0' || host === '::') return [];
  return ['127.0.0.1'];
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
    // Present-but-broken must fail loudly, never fall back to defaults.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`server.json at ${file} is not valid JSON: ${(err as Error).message}`);
    }
  }

  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`server.json at ${file} is invalid: ${z.prettifyError(parsed.error)}`);
  }
  const f = parsed.data;

  const interfaces = opts.interfaces ?? networkInterfaces();
  const tailnet = f.host ? null : detectTailscaleIp(interfaces);
  const host = f.host ?? tailnet ?? '127.0.0.1';

  return {
    host,
    hostIsFallback: !f.host && !tailnet,
    port: portFromEnv(env) ?? f.port ?? DEFAULT_PORT,
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
