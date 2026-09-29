import { useState, useEffect, useCallback, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { logAndForget } from "@/lib/fireAndLog";
import { api } from '@/lib/api';
import { useSaveStatus } from '@/components/settings-panels/saveStatus';

export interface ProxySettings {
  http_proxy: string | null;
  https_proxy: string | null;
  no_proxy: string | null;
  all_proxy: string | null;
  enabled: boolean;
}

interface ProxySettingsProps {
  setToast: (toast: { message: string; type: 'success' | 'error' } | null) => void;
}

const EMPTY: ProxySettings = {
  http_proxy: null,
  https_proxy: null,
  no_proxy: null,
  all_proxy: null,
  enabled: false,
};

const sameSettings = (a: ProxySettings, b: ProxySettings) =>
  (Object.keys(EMPTY) as (keyof ProxySettings)[]).every((k) => a[k] === b[k]);

/**
 * Proxy settings save like every other setting: the switch at once, an
 * address when its field is left (a half-typed URL is never applied).
 * Outcomes go to the Settings save indicator.
 */
export function ProxySettings({ setToast }: ProxySettingsProps) {
  const { track } = useSaveStatus();
  const [settings, setSettings] = useState<ProxySettings>(EMPTY);
  // What is on disk, so leaving a field unchanged doesn't save again.
  const savedRef = useRef<ProxySettings>(EMPTY);

  const loadSettings = useCallback(async () => {
    try {
      const loadedSettings = await api.getProxySettings<ProxySettings>();
      setSettings(loadedSettings);
      savedRef.current = loadedSettings;
    } catch (error) {
      console.error('Failed to load proxy settings:', error);
      setToast({
        message: 'Failed to load proxy settings',
        type: 'error',
      });
    }
  }, [setToast]);

  useEffect(() => {
    logAndForget('proxy-settings:load-settings', loadSettings());
  }, [loadSettings]);

  const save = (next: ProxySettings) => {
    if (sameSettings(next, savedRef.current)) return;
    void track(api.saveProxySettings(next)).then((ok) => {
      if (ok) savedRef.current = next;
    });
  };

  const handleInputChange = (field: keyof ProxySettings, value: string) => {
    setSettings(prev => ({
      ...prev,
      [field]: value || null,
    }));
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Proxy Settings</h3>
        <p className="text-sm text-muted-foreground">
          Configure proxy settings for Claude API requests
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="proxy-enabled">Enable Proxy</Label>
            <p className="text-sm text-muted-foreground">
              Use proxy for all Claude API requests
            </p>
          </div>
          <Switch
            id="proxy-enabled"
            checked={settings.enabled}
            onCheckedChange={(checked) => {
              const next = { ...settings, enabled: checked };
              setSettings(next);
              save(next);
            }}
          />
        </div>

        <div className="space-y-4" style={{ opacity: settings.enabled ? 1 : 0.5 }}>
          <div className="space-y-2">
            <Label htmlFor="http-proxy">HTTP Proxy</Label>
            <Input
              id="http-proxy"
              placeholder="http://proxy.example.com:8080"
              value={settings.http_proxy || ''}
              onChange={(e) => { handleInputChange('http_proxy', e.target.value); }}
              onBlur={() => { save(settings); }}
              disabled={!settings.enabled}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="https-proxy">HTTPS Proxy</Label>
            <Input
              id="https-proxy"
              placeholder="http://proxy.example.com:8080"
              value={settings.https_proxy || ''}
              onChange={(e) => { handleInputChange('https_proxy', e.target.value); }}
              onBlur={() => { save(settings); }}
              disabled={!settings.enabled}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="no-proxy">No Proxy</Label>
            <Input
              id="no-proxy"
              placeholder="localhost,127.0.0.1,.example.com"
              value={settings.no_proxy || ''}
              onChange={(e) => { handleInputChange('no_proxy', e.target.value); }}
              onBlur={() => { save(settings); }}
              disabled={!settings.enabled}
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated list of hosts that should bypass the proxy
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="all-proxy">All Proxy (Optional)</Label>
            <Input
              id="all-proxy"
              placeholder="socks5://proxy.example.com:1080"
              value={settings.all_proxy || ''}
              onChange={(e) => { handleInputChange('all_proxy', e.target.value); }}
              onBlur={() => { save(settings); }}
              disabled={!settings.enabled}
            />
            <p className="text-xs text-muted-foreground">
              Proxy URL to use for all protocols if protocol-specific proxies are not set
            </p>
          </div>
        </div>

      </div>
    </div>
  );
}