import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  detectTailscaleIp,
  loadServerConfig,
  DEFAULT_PORT,
  type NetworkInterfaces,
} from '../remote/config';

const IFACES: NetworkInterfaces = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
  utun4: [
    { address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false },
    { address: '100.101.102.103', family: 'IPv4', internal: false },
  ],
};

describe('remote server config', () => {
  describe('detectTailscaleIp', () => {
    it('finds the CGNAT-range IPv4 that Tailscale assigns', () => {
      expect(detectTailscaleIp(IFACES)).toBe('100.101.102.103');
    });

    it('returns null with no Tailscale interface up', () => {
      const { utun4: _utun, ...rest } = IFACES;
      expect(detectTailscaleIp(rest)).toBeNull();
    });

    it('does not mistake a public 100.x address for Tailscale', () => {
      // 100.64.0.0/10 is 100.64.0.0 – 100.127.255.255. 100.128.0.1 is outside it.
      expect(detectTailscaleIp({ en1: [{ address: '100.128.0.1', family: 'IPv4', internal: false }] })).toBeNull();
      expect(detectTailscaleIp({ en1: [{ address: '100.64.0.1', family: 'IPv4', internal: false }] })).toBe('100.64.0.1');
      expect(detectTailscaleIp({ en1: [{ address: '100.127.255.254', family: 'IPv4', internal: false }] })).toBe('100.127.255.254');
    });
  });

  describe('loadServerConfig', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omnifex-config-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('binds to the Tailscale IP when one is up and the file says nothing', () => {
      const cfg = loadServerConfig({ file: join(dir, 'server.json'), interfaces: IFACES, env: {} });
      expect(cfg.host).toBe('100.101.102.103');
      expect(cfg.port).toBe(DEFAULT_PORT);
    });

    it('falls back to loopback, never 0.0.0.0, with no Tailscale', () => {
      const { utun4: _utun, ...rest } = IFACES;
      const cfg = loadServerConfig({ file: join(dir, 'server.json'), interfaces: rest });
      expect(cfg.host).toBe('127.0.0.1');
    });

    it('lets the file override host, port, webRoot, ringSize and the permission timeout', () => {
      const file = join(dir, 'server.json');
      writeFileSync(file, JSON.stringify({
        host: '0.0.0.0',
        port: 5555,
        webRoot: '/srv/omnifex-web',
        ringSize: 100,
        permissionTimeoutMs: 60000,
      }));
      const cfg = loadServerConfig({ file, interfaces: IFACES });
      expect(cfg).toMatchObject({
        host: '0.0.0.0',
        port: 5555,
        webRoot: '/srv/omnifex-web',
        ringSize: 100,
        permissionTimeoutMs: 60000,
      });
    });

    it('defaults the permission timeout to never and the state dir under ~/.omnifex', () => {
      // `env: {}` so a shell that exported OMNIFEX_STATE_DIR for a smoke run
      // cannot leak into this expectation.
      const cfg = loadServerConfig({ file: join(dir, 'server.json'), interfaces: IFACES, env: {} });
      expect(cfg.permissionTimeoutMs).toBeNull();
      expect(cfg.stateDir).toBe(join(homedir(), '.omnifex'));
      expect(cfg.sessionsDir).toBe(join(homedir(), '.omnifex', 'sessions'));
      expect(cfg.projectsFile).toBe(join(homedir(), '.omnifex', 'projects.json'));
      expect(cfg.userDataDir).toBe(join(homedir(), 'Library', 'Application Support', 'OmniFex'));
    });

    it('lets OMNIFEX_STATE_DIR relocate everything for a throwaway run', () => {
      const cfg = loadServerConfig({
        file: join(dir, 'server.json'),
        interfaces: IFACES,
        env: { OMNIFEX_STATE_DIR: join(dir, 'state'), OMNIFEX_USER_DATA_DIR: join(dir, 'ud') },
      });
      expect(cfg.stateDir).toBe(join(dir, 'state'));
      expect(cfg.sessionsDir).toBe(join(dir, 'state', 'sessions'));
      expect(cfg.userDataDir).toBe(join(dir, 'ud'));
    });

    it('rejects a port outside 1–65535 and ignores unknown keys', () => {
      const file = join(dir, 'server.json');
      writeFileSync(file, JSON.stringify({ port: 70000, mystery: true }));
      expect(() => loadServerConfig({ file, interfaces: IFACES })).toThrow(/port/);
    });

    it('treats a corrupt file as an error, not as defaults', () => {
      // Silently running on loopback with the wrong port would look like a
      // network problem from the iPad. Fail where the user can read it.
      const file = join(dir, 'server.json');
      writeFileSync(file, '{not json');
      expect(() => loadServerConfig({ file, interfaces: IFACES })).toThrow(/server\.json/);
    });
  });
});
