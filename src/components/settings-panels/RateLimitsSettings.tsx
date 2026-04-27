import React, { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, type RateLimitSettings } from '@/lib/api';
import type { SettingsPanelProps } from './types';

const DEFAULT_THRESHOLDS = '75, 90';

function thresholdsToText(values: number[] | undefined): string {
  if (!values || values.length === 0) return '';
  return values.join(', ');
}

function parseThresholds(text: string): number[] | null {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  const nums: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || n < 1 || n > 99) return null;
    nums.push(Math.round(n));
  }
  // de-dupe + sort ascending
  return Array.from(new Set(nums)).sort((a, b) => a - b);
}

export const RateLimitsSettings: React.FC<SettingsPanelProps> = ({ setToast }) => {
  const [settings, setSettings] = useState<RateLimitSettings | null>(null);
  const [fiveHourText, setFiveHourText] = useState<string>(DEFAULT_THRESHOLDS);
  const [sevenDayText, setSevenDayText] = useState<string>(DEFAULT_THRESHOLDS);
  const [fiveHourError, setFiveHourError] = useState<string | null>(null);
  const [sevenDayError, setSevenDayError] = useState<string | null>(null);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    api.getRateLimitSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        setFiveHourText(thresholdsToText(s.five_hour_thresholds_pct));
        setSevenDayText(thresholdsToText(s.seven_day_thresholds_pct));
      })
      .catch((err) => {
        console.error('[settings] failed to load rate-limit settings:', err);
        setToast({ message: 'Could not load rate-limit settings', type: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [setToast]);

  const persist = useCallback(
    async (partial: Partial<RateLimitSettings>) => {
      try {
        const merged = await api.updateRateLimitSettings(partial);
        setSettings(merged);
      } catch (err) {
        console.error('[settings] failed to save rate-limit settings:', err);
        setToast({ message: 'Failed to save rate-limit settings', type: 'error' });
      }
    },
    [setToast],
  );

  const handleFiveHourBlur = useCallback(() => {
    const parsed = parseThresholds(fiveHourText);
    if (parsed === null) {
      setFiveHourError('Use comma-separated whole numbers between 1 and 99 (e.g. "75, 90").');
      return;
    }
    setFiveHourError(null);
    setFiveHourText(thresholdsToText(parsed));
    void persist({ five_hour_thresholds_pct: parsed });
  }, [fiveHourText, persist]);

  const handleSevenDayBlur = useCallback(() => {
    const parsed = parseThresholds(sevenDayText);
    if (parsed === null) {
      setSevenDayError('Use comma-separated whole numbers between 1 and 99.');
      return;
    }
    setSevenDayError(null);
    setSevenDayText(thresholdsToText(parsed));
    void persist({ seven_day_thresholds_pct: parsed });
  }, [sevenDayText, persist]);

  if (!settings) {
    return (
      <Card className="p-6">
        <p className="text-sm text-muted-foreground">Loading rate-limit settings…</p>
      </Card>
    );
  }

  return (
    <Card className="p-6 space-y-6">
      <div>
        <h3 className="text-heading-4 mb-1">Rate-limit notifications</h3>
        <p className="text-caption text-muted-foreground">
          GreyChrist captures Anthropic's rate-limit signals from the Agent SDK as your sessions
          stream. Use these settings to control when you're notified about your 5-hour and 7-day
          windows.
        </p>
      </div>

      {/* Master toggle */}
      <div className="flex items-center justify-between">
        <div>
          <Label>Enable rate-limit notifications</Label>
          <p className="text-caption text-muted-foreground mt-1">
            Master switch. When off, GreyChrist still tracks utilization for the in-app widget but
            won't fire OS notifications.
          </p>
        </div>
        <Switch
          checked={settings.notifications_enabled}
          onCheckedChange={(checked) => void persist({ notifications_enabled: checked })}
        />
      </div>

      {/* 5-hour thresholds */}
      <div className="space-y-2">
        <Label>5-hour window thresholds (%)</Label>
        <Input
          value={fiveHourText}
          onChange={(e) => setFiveHourText(e.target.value)}
          onBlur={handleFiveHourBlur}
          placeholder={DEFAULT_THRESHOLDS}
          className="max-w-sm"
        />
        {fiveHourError ? (
          <p className="text-caption text-destructive">{fiveHourError}</p>
        ) : (
          <p className="text-caption text-muted-foreground">
            Notifies once when your 5-hour window crosses each percent. Defaults to 75, 90.
          </p>
        )}
      </div>

      {/* 7-day toggle + thresholds */}
      <div className="flex items-center justify-between">
        <div>
          <Label>Enable 7-day notifications</Label>
          <p className="text-caption text-muted-foreground mt-1">
            Off by default — most users only need 5-hour alerts.
          </p>
        </div>
        <Switch
          checked={settings.seven_day_notifications_enabled}
          onCheckedChange={(checked) =>
            void persist({ seven_day_notifications_enabled: checked })
          }
        />
      </div>
      <div className="space-y-2">
        <Label>7-day window thresholds (%)</Label>
        <Input
          value={sevenDayText}
          onChange={(e) => setSevenDayText(e.target.value)}
          onBlur={handleSevenDayBlur}
          placeholder={DEFAULT_THRESHOLDS}
          className="max-w-sm"
          disabled={!settings.seven_day_notifications_enabled}
        />
        {sevenDayError ? (
          <p className="text-caption text-destructive">{sevenDayError}</p>
        ) : (
          <p className="text-caption text-muted-foreground">
            Used only when 7-day notifications are enabled.
          </p>
        )}
      </div>

      <div className="border-t border-border/50 pt-4">
        <p className="text-caption text-muted-foreground">
          Whenever Anthropic's SDK reports an{' '}
          <code className="font-mono">allowed_warning</code> or{' '}
          <code className="font-mono">rejected</code> status, you'll get a notification regardless
          of these thresholds — those are authoritative signals from the API.
        </p>
      </div>
    </Card>
  );
};
