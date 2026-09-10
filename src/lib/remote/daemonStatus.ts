/**
 * What the title bar's Daemon button shows: where `/healthz` is for the
 * daemon this page is attached to, and the shape of its answer.
 *
 * The socket URL is the only thing the renderer knows about the daemon's
 * address (Electron gets it from `remote:url`; the web client is served by
 * the daemon itself), so the health URL is derived from it rather than
 * configured twice.
 */

export interface DaemonHealthInfo {
  ok: boolean;
  version: string;
  protocolVersion: number;
  uptimeSec: number;
  host: string;
  port: number;
  clients: number;
  sessions: { live: number; known: number; inFlight: number };
}

export interface RemoteInfoLike {
  mode: 'electron-legacy' | 'electron-remote' | 'web';
  url: string | null;
}

/** `ws(s)://host:port/ws` → `http(s)://host:port/healthz`; same origin on the web. */
export function daemonHealthUrl(info: RemoteInfoLike | undefined, origin: string): string | null {
  if (!info) return null;
  if (info.mode === 'web') return `${origin}/healthz`;
  if (info.mode === 'electron-remote' && info.url) {
    return info.url.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws$/, '/healthz');
  }
  return null;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Tolerant of an older daemon missing newer fields; null only when it is not a health body at all. */
export function parseDaemonHealthInfo(body: unknown): DaemonHealthInfo | null {
  if (!body || typeof body !== 'object') return null;
  const h = body as Record<string, unknown>;
  if (typeof h.version !== 'string') return null;
  const s = (h.sessions ?? {}) as Record<string, unknown>;
  return {
    ok: h.ok === true,
    version: h.version,
    protocolVersion: num(h.protocolVersion),
    uptimeSec: num(h.uptimeSec),
    host: typeof h.host === 'string' ? h.host : '',
    port: num(h.port),
    clients: num(h.clients),
    sessions: { live: num(s.live), known: num(s.known), inFlight: num(s.inFlight) },
  };
}

export async function fetchDaemonHealth(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DaemonHealthInfo | null> {
  const res = await fetchImpl(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return parseDaemonHealthInfo(await res.json());
}

/** `45s`, `12m`, `4h 12m`, `3d 4h`. */
export function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
