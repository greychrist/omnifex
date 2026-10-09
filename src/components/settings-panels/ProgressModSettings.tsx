import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { fireAndLog } from "@/lib/fireAndLog";
import { PROGRESS_MOD_ENABLED_KEY, progressModEnabled } from "@/lib/progressModSettings";
import { useSaveStatus } from "./saveStatus";

/**
 * Agent step progress: whether sessions load OmniFex's bundled mod, which
 * gives the model a progress tool so the agents readout can show real steps.
 * Read at each spawn (`electron/services/bundled-mod.ts`), so a change reaches
 * the next session, not the ones already running.
 */
export function ProgressModSettings() {
  const { track } = useSaveStatus();
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.getSetting(PROGRESS_MOD_ENABLED_KEY)
      .then((stored) => { if (!cancelled) setEnabled(progressModEnabled(stored)); })
      .catch(() => { /* default stands */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex items-center justify-between">
      <div className="space-y-1">
        <Label htmlFor="progress-mod-enabled">Agent step progress</Label>
        <p className="text-caption text-muted-foreground">
          Give Claude and its agents a progress tool, so each agent&apos;s bar fills
          step by step. Each report is a small tool call. Applies to sessions
          started after the change.
        </p>
      </div>
      <Switch
        id="progress-mod-enabled"
        checked={enabled}
        onCheckedChange={fireAndLog('progress-mod-settings:checked-change', (checked: boolean) => {
          setEnabled(checked);
          void track(api.saveSetting(PROGRESS_MOD_ENABLED_KEY, checked ? 'true' : 'false'));
        })}
      />
    </div>
  );
}
