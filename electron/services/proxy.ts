import type { Database } from './database';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ProxySettings {
  http_proxy?: string;
  https_proxy?: string;
  no_proxy?: string;
  enabled: boolean;
}

export interface ProxyService {
  getSettings(): ProxySettings;
  saveSettings(settings: ProxySettings): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'proxy_settings';

const DEFAULT_SETTINGS: ProxySettings = {
  enabled: false,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProxyService(db: Database): ProxyService {
  function getSettings(): ProxySettings {
    const raw = db.getSetting(SETTINGS_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    try {
      return JSON.parse(raw) as ProxySettings;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(settings: ProxySettings): void {
    db.saveSetting(SETTINGS_KEY, JSON.stringify(settings));

    if (settings.enabled) {
      if (settings.http_proxy) {
        process.env.HTTP_PROXY = settings.http_proxy;
      } else {
        delete process.env.HTTP_PROXY;
      }

      if (settings.https_proxy) {
        process.env.HTTPS_PROXY = settings.https_proxy;
      } else {
        delete process.env.HTTPS_PROXY;
      }

      if (settings.no_proxy) {
        process.env.NO_PROXY = settings.no_proxy;
      } else {
        delete process.env.NO_PROXY;
      }
    } else {
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.NO_PROXY;
    }
  }

  return { getSettings, saveSettings };
}
