import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { fireAndLog } from "@/lib/fireAndLog";
import {
  AUTO_RECAP_DELAY_KEY,
  AUTO_RECAP_ENABLED_KEY,
  DEFAULT_AUTO_RECAP_MINUTES,
  autoRecapEnabled,
  autoRecapMinutes,
} from "@/lib/autoRecapSettings";
import { useSaveStatus } from "./saveStatus";

/**
 * Automatic `/recap` after a finished turn goes unanswered. Main owns the
 * timer (`electron/services/sessions/auto-recap.ts`) and reads these settings
 * fresh each time, so a change applies to sessions already open.
 */
export function AutoRecapSettings() {
  const { track } = useSaveStatus();
  const [enabled, setEnabled] = useState(true);
  const [minutes, setMinutes] = useState(DEFAULT_AUTO_RECAP_MINUTES);
  const [draft, setDraft] = useState(String(DEFAULT_AUTO_RECAP_MINUTES));

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getSetting(AUTO_RECAP_ENABLED_KEY), api.getSetting(AUTO_RECAP_DELAY_KEY)])
      .then(([storedEnabled, storedDelay]) => {
        if (cancelled) return;
        setEnabled(autoRecapEnabled(storedEnabled));
        const m = autoRecapMinutes(storedDelay);
        setMinutes(m);
        setDraft(String(m));
      })
      .catch(() => { /* defaults stand */ });
    return () => { cancelled = true; };
  }, []);

  const commitMinutes = () => {
    const next = Number(draft);
    if (!Number.isFinite(next) || next <= 0) {
      setDraft(String(minutes));
      return;
    }
    if (next === minutes) return;
    setMinutes(next);
    void track(api.saveSetting(AUTO_RECAP_DELAY_KEY, String(next)));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <Label htmlFor="auto-recap-enabled">Recap idle sessions</Label>
          <p className="text-caption text-muted-foreground">
            When a turn finishes and you haven&apos;t replied, run <code>/recap</code> once,
            so the tab says where things stand when you come back. Each recap is a
            short model call on the session&apos;s model.
          </p>
        </div>
        <Switch
          id="auto-recap-enabled"
          checked={enabled}
          onCheckedChange={fireAndLog('auto-recap-settings:checked-change', (checked: boolean) => {
            setEnabled(checked);
            void track(api.saveSetting(AUTO_RECAP_ENABLED_KEY, checked ? 'true' : 'false'));
          })}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="auto-recap-minutes" className="text-body-small">
          Minutes before the recap
        </Label>
        <Input
          id="auto-recap-minutes"
          type="number"
          min={1}
          step={1}
          className="w-32"
          disabled={!enabled}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitMinutes}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </div>
    </div>
  );
}
