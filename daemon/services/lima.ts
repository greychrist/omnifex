import { execFileOnPath } from './util/spawn';

export interface LimaVm {
  name: string;
  status: string;
  arch: string;
  cpus: number;
  memoryBytes: number;
  diskBytes: number;
  dir: string;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

export interface LimaExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface LimaExecOptions {
  timeoutMs?: number;
}

export interface LimaDeps {
  execLimactl?: (args: string[], opts?: LimaExecOptions) => Promise<LimaExecResult>;
}

export interface LimaService {
  isInstalled(): Promise<boolean>;
  listVms(): Promise<LimaVm[]>;
  listContainers(vmName: string): Promise<DockerContainer[]>;
  startVm(vmName: string): Promise<void>;
  stopVm(vmName: string): Promise<void>;
  startContainer(vmName: string, containerId: string): Promise<void>;
  stopContainer(vmName: string, containerId: string): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 8000;
const LIFECYCLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

function defaultExecLimactl(args: string[], opts: LimaExecOptions = {}): Promise<LimaExecResult> {
  return new Promise((resolve, reject) => {
    // Resolved, never bare: polled every few seconds (see util/spawn.ts).
    execFileOnPath(
      'limactl',
      args,
      { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: DEFAULT_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          // ENOENT and timeouts reject, so callers can tell "not installed" from "ran but failed".
          const errno = err.code;
          if (errno === 'ENOENT' || errno === 'ETIMEDOUT') {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejection reason is a structured non-Error object by API contract.
            reject(err);
            return;
          }
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            code: typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 1,
          });
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr), code: 0 });
      },
    );
  });
}

interface RawLimaVmJson {
  name?: string;
  status?: string;
  arch?: string;
  cpus?: number;
  memory?: number;
  disk?: number;
  dir?: string;
}

interface RawDockerPsJson {
  ID?: string;
  Names?: string;
  Image?: string;
  State?: string;
  Status?: string;
  Ports?: string;
}

function parseNdjson<T>(stdout: string): T[] {
  const out: T[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip it: limactl/docker can interleave warnings on stdout.
    }
  }
  return out;
}

export function createLimaService(deps: LimaDeps = {}): LimaService {
  const exec = deps.execLimactl ?? defaultExecLimactl;

  async function isInstalled(): Promise<boolean> {
    try {
      const result = await exec(['--version']);
      return result.code === 0;
    } catch {
      return false;
    }
  }

  async function listVms(): Promise<LimaVm[]> {
    let result: LimaExecResult;
    try {
      result = await exec(['list', '--json']);
    } catch {
      return [];
    }
    if (result.code !== 0) return [];

    const raw = parseNdjson<RawLimaVmJson>(result.stdout);
    return raw
      .filter((v): v is RawLimaVmJson & { name: string } => typeof v.name === 'string' && v.name.length > 0)
      .map((v) => ({
        name: v.name,
        status: v.status ?? 'Unknown',
        arch: v.arch ?? '',
        cpus: typeof v.cpus === 'number' ? v.cpus : 0,
        memoryBytes: typeof v.memory === 'number' ? v.memory : 0,
        diskBytes: typeof v.disk === 'number' ? v.disk : 0,
        dir: v.dir ?? '',
      }));
  }

  async function listContainers(vmName: string): Promise<DockerContainer[]> {
    let result: LimaExecResult;
    try {
      result = await exec(['shell', vmName, '--', 'docker', 'ps', '-a', '--format={{json .}}']);
    } catch {
      return [];
    }
    if (result.code !== 0) return [];

    const raw = parseNdjson<RawDockerPsJson>(result.stdout);
    return raw
      .filter((c): c is RawDockerPsJson & { ID: string } => typeof c.ID === 'string' && c.ID.length > 0)
      .map((c) => ({
        id: c.ID,
        name: c.Names ?? '',
        image: c.Image ?? '',
        state: c.State ?? '',
        status: c.Status ?? '',
        ports: c.Ports ?? '',
      }));
  }

  async function startVm(vmName: string): Promise<void> {
    const result = await exec(['start', vmName], { timeoutMs: LIFECYCLE_TIMEOUT_MS });
    if (result.code !== 0) {
      const msg = result.stderr.trim() || result.stdout.trim() || `limactl start exited with code ${result.code}`;
      throw new Error(msg);
    }
  }

  async function stopVm(vmName: string): Promise<void> {
    const result = await exec(['stop', vmName], { timeoutMs: LIFECYCLE_TIMEOUT_MS });
    if (result.code !== 0) {
      const msg = result.stderr.trim() || result.stdout.trim() || `limactl stop exited with code ${result.code}`;
      throw new Error(msg);
    }
  }

  async function startContainer(vmName: string, containerId: string): Promise<void> {
    const result = await exec(['shell', vmName, '--', 'docker', 'start', containerId]);
    if (result.code !== 0) {
      const msg = result.stderr.trim() || result.stdout.trim() || `docker start exited with code ${result.code}`;
      throw new Error(msg);
    }
  }

  async function stopContainer(vmName: string, containerId: string): Promise<void> {
    const result = await exec(['shell', vmName, '--', 'docker', 'stop', containerId]);
    if (result.code !== 0) {
      const msg = result.stderr.trim() || result.stdout.trim() || `docker stop exited with code ${result.code}`;
      throw new Error(msg);
    }
  }

  return { isInstalled, listVms, listContainers, startVm, stopVm, startContainer, stopContainer };
}
