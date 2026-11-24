import { describe, it, expect, vi } from 'vitest';
import { createLimaService } from '../services/lima';

function makeFakeExec(map: Record<string, { stdout: string; stderr?: string; code?: number }>) {
  return vi.fn(async (args: string[]) => {
    const key = args.join(' ');
    const hit = map[key];
    if (!hit) {
      const err: NodeJS.ErrnoException = new Error(`unexpected limactl args: ${key}`);
      err.code = 'ENOENT';
      throw err;
    }
    return { stdout: hit.stdout, stderr: hit.stderr ?? '', code: hit.code ?? 0 };
  });
}

describe('lima service', () => {
  describe('isInstalled', () => {
    it('returns true when limactl --version succeeds', async () => {
      const exec = makeFakeExec({
        '--version': { stdout: 'limactl version 1.0.0\n' },
      });
      const service = createLimaService({ execLimactl: exec });
      expect(await service.isInstalled()).toBe(true);
    });

    it('returns false when limactl is missing (ENOENT)', async () => {
      const exec = vi.fn(async () => {
        const err: NodeJS.ErrnoException = new Error('not found');
        err.code = 'ENOENT';
        throw err;
      });
      const service = createLimaService({ execLimactl: exec });
      expect(await service.isInstalled()).toBe(false);
    });
  });

  describe('listVms', () => {
    it('parses NDJSON output from `limactl list --json`', async () => {
      const exec = makeFakeExec({
        'list --json': {
          stdout:
            '{"name":"default","status":"Running","arch":"aarch64","cpus":4,"memory":4294967296,"disk":107374182400,"dir":"/Users/u/.lima/default"}\n' +
            '{"name":"docker","status":"Stopped","arch":"aarch64","cpus":2,"memory":2147483648,"disk":53687091200,"dir":"/Users/u/.lima/docker"}\n',
        },
      });
      const service = createLimaService({ execLimactl: exec });
      const vms = await service.listVms();

      expect(vms).toHaveLength(2);
      expect(vms[0]).toMatchObject({
        name: 'default',
        status: 'Running',
        arch: 'aarch64',
        cpus: 4,
        memoryBytes: 4294967296,
        diskBytes: 107374182400,
        dir: '/Users/u/.lima/default',
      });
      expect(vms[1].name).toBe('docker');
      expect(vms[1].status).toBe('Stopped');
    });

    it('returns [] when limactl is not installed', async () => {
      const exec = vi.fn(async () => {
        const err: NodeJS.ErrnoException = new Error('not found');
        err.code = 'ENOENT';
        throw err;
      });
      const service = createLimaService({ execLimactl: exec });
      expect(await service.listVms()).toEqual([]);
    });

    it('returns [] when no VMs are configured (empty stdout)', async () => {
      const exec = makeFakeExec({ 'list --json': { stdout: '' } });
      const service = createLimaService({ execLimactl: exec });
      expect(await service.listVms()).toEqual([]);
    });

    it('skips malformed JSON lines without throwing', async () => {
      const exec = makeFakeExec({
        'list --json': {
          stdout:
            '{"name":"good","status":"Running","arch":"aarch64","cpus":2,"memory":1024,"disk":2048,"dir":"/d"}\n' +
            'not-json-at-all\n' +
            '{"name":"another","status":"Stopped","arch":"x86_64","cpus":1,"memory":512,"disk":1024,"dir":"/e"}\n',
        },
      });
      const service = createLimaService({ execLimactl: exec });
      const vms = await service.listVms();
      expect(vms.map((v) => v.name)).toEqual(['good', 'another']);
    });
  });

  describe('listContainers', () => {
    it('runs `limactl shell <name> docker ps -a --format=json` and parses NDJSON', async () => {
      const exec = makeFakeExec({
        'shell default -- docker ps -a --format={{json .}}': {
          stdout:
            '{"ID":"abc123","Names":"redis","Image":"redis:7","State":"running","Status":"Up 2 hours","Ports":"0.0.0.0:6379->6379/tcp"}\n' +
            '{"ID":"def456","Names":"db","Image":"postgres:15","State":"exited","Status":"Exited (0) 5 minutes ago","Ports":""}\n',
        },
      });
      const service = createLimaService({ execLimactl: exec });
      const containers = await service.listContainers('default');

      expect(containers).toHaveLength(2);
      expect(containers[0]).toMatchObject({
        id: 'abc123',
        name: 'redis',
        image: 'redis:7',
        state: 'running',
        status: 'Up 2 hours',
        ports: '0.0.0.0:6379->6379/tcp',
      });
      expect(containers[1].name).toBe('db');
      expect(containers[1].state).toBe('exited');
    });

    it('returns [] when the shell command fails (e.g. VM stopped, docker missing)', async () => {
      const exec = vi.fn(async () => ({
        stdout: '',
        stderr: 'instance "default" is stopped',
        code: 1,
      }));
      const service = createLimaService({ execLimactl: exec });
      expect(await service.listContainers('default')).toEqual([]);
    });

    it('returns [] when limactl itself is missing', async () => {
      const exec = vi.fn(async () => {
        const err: NodeJS.ErrnoException = new Error('not found');
        err.code = 'ENOENT';
        throw err;
      });
      const service = createLimaService({ execLimactl: exec });
      expect(await service.listContainers('default')).toEqual([]);
    });
  });

  describe('startVm', () => {
    it('runs `limactl start <name>` and resolves on success', async () => {
      const exec = makeFakeExec({ 'start default': { stdout: 'READY' } });
      const service = createLimaService({ execLimactl: exec });
      await expect(service.startVm('default')).resolves.toBeUndefined();
      expect(exec).toHaveBeenCalledWith(['start', 'default'], expect.objectContaining({ timeoutMs: expect.any(Number) }));
    });

    it('rejects with the stderr message on non-zero exit', async () => {
      const exec = vi.fn(async () => ({ stdout: '', stderr: 'instance is broken', code: 1 }));
      const service = createLimaService({ execLimactl: exec });
      await expect(service.startVm('default')).rejects.toThrow(/instance is broken/);
    });

    it('rejects when limactl is missing', async () => {
      const exec = vi.fn(async () => {
        const err: NodeJS.ErrnoException = new Error('not found');
        err.code = 'ENOENT';
        throw err;
      });
      const service = createLimaService({ execLimactl: exec });
      await expect(service.startVm('default')).rejects.toThrow();
    });
  });

  describe('stopVm', () => {
    it('runs `limactl stop <name>` and resolves on success', async () => {
      const exec = makeFakeExec({ 'stop default': { stdout: 'has shut down' } });
      const service = createLimaService({ execLimactl: exec });
      await expect(service.stopVm('default')).resolves.toBeUndefined();
      expect(exec).toHaveBeenCalledWith(['stop', 'default'], expect.objectContaining({ timeoutMs: expect.any(Number) }));
    });

    it('rejects with the stderr message on non-zero exit', async () => {
      const exec = vi.fn(async () => ({ stdout: '', stderr: 'no such instance', code: 1 }));
      const service = createLimaService({ execLimactl: exec });
      await expect(service.stopVm('ghost')).rejects.toThrow(/no such instance/);
    });
  });

  describe('startContainer', () => {
    it('runs `limactl shell <vm> docker start <id>` (non-destructive)', async () => {
      const exec = makeFakeExec({
        'shell default -- docker start abc123': { stdout: 'abc123\n' },
      });
      const service = createLimaService({ execLimactl: exec });
      await expect(service.startContainer('default', 'abc123')).resolves.toBeUndefined();
    });

    it('rejects with the stderr message on non-zero exit', async () => {
      const exec = vi.fn(async () => ({
        stdout: '',
        stderr: 'No such container: zzz',
        code: 1,
      }));
      const service = createLimaService({ execLimactl: exec });
      await expect(service.startContainer('default', 'zzz')).rejects.toThrow(/No such container/);
    });
  });

  describe('stopContainer', () => {
    it('runs `limactl shell <vm> docker stop <id>` (non-destructive)', async () => {
      const exec = makeFakeExec({
        'shell default -- docker stop abc123': { stdout: 'abc123\n' },
      });
      const service = createLimaService({ execLimactl: exec });
      await expect(service.stopContainer('default', 'abc123')).resolves.toBeUndefined();
    });

    it('rejects with the stderr message on non-zero exit', async () => {
      const exec = vi.fn(async () => ({
        stdout: '',
        stderr: 'No such container: zzz',
        code: 1,
      }));
      const service = createLimaService({ execLimactl: exec });
      await expect(service.stopContainer('default', 'zzz')).rejects.toThrow(/No such container/);
    });
  });
});
