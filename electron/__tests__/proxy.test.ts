import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createProxyService, type ProxyService } from '../services/proxy';

describe('proxy service', () => {
  let db: Database;
  let proxy: ProxyService;

  // Save and restore env vars around each test
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    db = createDatabase(':memory:');
    proxy = createProxyService(db);

    savedEnv = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NO_PROXY: process.env.NO_PROXY,
    };

    // Reset env
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;
  });

  afterEach(() => {
    // Restore env
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    db.close();
  });

  it('getSettings returns defaults when nothing saved', () => {
    const settings = proxy.getSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.http_proxy).toBeUndefined();
    expect(settings.https_proxy).toBeUndefined();
    expect(settings.no_proxy).toBeUndefined();
  });

  it('saveSettings persists and getSettings retrieves', () => {
    proxy.saveSettings({
      enabled: true,
      http_proxy: 'http://proxy.example.com:8080',
      https_proxy: 'https://proxy.example.com:8080',
      no_proxy: 'localhost,127.0.0.1',
    });

    const settings = proxy.getSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.http_proxy).toBe('http://proxy.example.com:8080');
    expect(settings.https_proxy).toBe('https://proxy.example.com:8080');
    expect(settings.no_proxy).toBe('localhost,127.0.0.1');
  });

  it('saveSettings with enabled=true sets process.env variables', () => {
    proxy.saveSettings({
      enabled: true,
      http_proxy: 'http://proxy.local:3128',
      https_proxy: 'https://proxy.local:3128',
      no_proxy: '*.internal',
    });

    expect(process.env.HTTP_PROXY).toBe('http://proxy.local:3128');
    expect(process.env.HTTPS_PROXY).toBe('https://proxy.local:3128');
    expect(process.env.NO_PROXY).toBe('*.internal');
  });

  it('saveSettings with enabled=false clears process.env variables', () => {
    // First enable it
    proxy.saveSettings({
      enabled: true,
      http_proxy: 'http://proxy.local:3128',
    });
    expect(process.env.HTTP_PROXY).toBe('http://proxy.local:3128');

    // Now disable
    proxy.saveSettings({
      enabled: false,
      http_proxy: 'http://proxy.local:3128',
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it('overwrites previously saved settings', () => {
    proxy.saveSettings({ enabled: false, http_proxy: 'http://old.example.com' });
    proxy.saveSettings({ enabled: true, http_proxy: 'http://new.example.com' });

    const settings = proxy.getSettings();
    expect(settings.http_proxy).toBe('http://new.example.com');
    expect(settings.enabled).toBe(true);
  });
});
