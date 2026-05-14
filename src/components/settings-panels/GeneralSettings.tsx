import React, { useState, useEffect } from "react";
import {
  AlertCircle,
  Check,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type ClaudeInstallation } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ClaudeVersionSelector } from "@/components/ClaudeVersionSelector";
import { useTheme } from "@/hooks";
import { useAppFont } from "@/contexts/AppFontContext";
import { APP_FONT_CHOICES, type Typeface } from "@/lib/typefaceCatalog";
import { TabPersistenceService } from "@/services/tabPersistence";
import type { SettingsPanelProps } from "./types";

// This panel no longer reads from `<configDir>/settings.json`. The three
// keys it used to expose (`includeCoAuthoredBy`, `verbose`,
// `cleanupPeriodDays`) were removed in May 2026 — the first is deprecated
// upstream, the second isn't in current Claude Code docs, and the third is
// load-bearing-but-rarely-tuned (Claude defaults to 30 days). Anyone who
// still wants to tune those can edit the per-account settings.json directly.

// Opens a macOS folder picker and returns the chosen path, or null on cancel.
// Duplicated from AccountSettings.tsx's pickFolder; pulled inline to keep this
// settings panel self-contained.
async function pickFolder(defaultPath?: string): Promise<string | null> {
  try {
    const paths = await window.electronAPI.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Update Source Folder',
      defaultPath: defaultPath || (await api.getHomeDirectory()),
    }) as string[] | null;
    return paths?.[0] ?? null;
  } catch {
    return null;
  }
}

interface GeneralSettingsProps extends SettingsPanelProps {
  currentBinaryPath: string | null;
  binaryPathChanged: boolean;
  onClaudeInstallationSelect: (installation: ClaudeInstallation) => void;
}

export const GeneralSettings: React.FC<GeneralSettingsProps> = ({
  setToast,
  currentBinaryPath,
  binaryPathChanged,
  onClaudeInstallationSelect,
}) => {
  const { theme, setTheme } = useTheme();
  const { appFont, setAppFont, isLoading: appFontLoading } = useAppFont();
  const [tabPersistenceEnabled, setTabPersistenceEnabled] = useState(true);
  const [startupIntroEnabled, setStartupIntroEnabled] = useState(true);
  // The directory the updater scans for newer OmniFex-<semver>-arm64.dmg
  // builds. Empty string → updates disabled. Persisted as `local_update_dir`
  // in app_settings and read lazily by the main-process updater on every
  // check, so changes here take effect immediately without a restart.
  const [localUpdateDir, setLocalUpdateDir] = useState<string>('');

  useEffect(() => {
    setTabPersistenceEnabled(TabPersistenceService.isEnabled());
    (async () => {
      const pref = await api.getSetting('startup_intro_enabled');
      setStartupIntroEnabled(pref === null ? true : pref === 'true');
      const dir = await api.getSetting('local_update_dir');
      setLocalUpdateDir(dir ?? '');
    })();
  }, []);

  const saveLocalUpdateDir = async (next: string) => {
    try {
      await api.saveSetting('local_update_dir', next);
      setToast({
        message: next ? `Update source set to ${next}` : 'Update source cleared',
        type: 'success',
      });
    } catch {
      setToast({ message: 'Failed to save update source', type: 'error' });
    }
  };

  return (
    <Card className="p-6 space-y-6">
      <div>
        <h3 className="text-heading-4 mb-4">General Settings</h3>

        <div className="space-y-4">
          {/* Theme Selector */}
          <div className="flex items-center justify-between">
            <div>
              <Label>Theme</Label>
              <p className="text-caption text-muted-foreground mt-1">
                Choose your preferred color theme
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-muted/30 rounded-lg">
              <button
                onClick={() => setTheme('gray')}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                  theme === 'gray'
                    ? "bg-background shadow-sm"
                    : "hover:bg-background/50"
                )}
              >
                {theme === 'gray' && <Check className="h-3 w-3" />}
                Gray
              </button>
              <button
                onClick={() => setTheme('light')}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                  theme === 'light'
                    ? "bg-background shadow-sm"
                    : "hover:bg-background/50"
                )}
              >
                {theme === 'light' && <Check className="h-3 w-3" />}
                Light
              </button>
            </div>
          </div>

          {/* App font (sits right under Theme — same row layout: label
              on left, control on right). Drives --font-sans globally
              for the whole UI. Chat-surface fonts are configured in
              the Chats tab's Typography card, separately from this. */}
          <div className="flex items-center justify-between">
            <div>
              <Label>App font</Label>
              <p className="text-caption text-muted-foreground mt-1">
                Global UI typeface — sidebar, settings, dialogs, project list
              </p>
            </div>
            <div className="w-48">
              <Select
                value={appFont}
                onValueChange={(v) => setAppFont(v)}
                disabled={appFontLoading}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {APP_FONT_CHOICES.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      <span style={{ fontFamily: t.cssFamily }}>{t.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Claude Binary Path Selector */}
          <div className="space-y-3">
            <ClaudeVersionSelector
              selectedPath={currentBinaryPath}
              onSelect={onClaudeInstallationSelect}
              simplified={true}
            />
            {binaryPathChanged && (
              <p className="text-caption text-amber-600 dark:text-amber-400 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                Changes will be applied when you save settings.
              </p>
            )}
          </div>

          {/* Separator */}
          <div className="border-t border-border pt-4 mt-6" />

          {/* Tab Persistence Toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="tab-persistence">Remember Open Tabs</Label>
              <p className="text-caption text-muted-foreground">
                Restore your tabs when you restart the app
              </p>
            </div>
            <Switch
              id="tab-persistence"
              checked={tabPersistenceEnabled}
              onCheckedChange={(checked) => {
                TabPersistenceService.setEnabled(checked);
                setTabPersistenceEnabled(checked);
                setToast({
                  message: checked
                    ? "Tab persistence enabled - your tabs will be restored on restart"
                    : "Tab persistence disabled - tabs will not be saved",
                  type: "success"
                });
              }}
            />
          </div>

          {/* Startup Intro Toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="startup-intro">Show Welcome Intro on Startup</Label>
              <p className="text-caption text-muted-foreground">
                Display a brief welcome animation when the app launches
              </p>
            </div>
            <Switch
              id="startup-intro"
              checked={startupIntroEnabled}
              onCheckedChange={async (checked) => {
                setStartupIntroEnabled(checked);
                try {
                  await api.saveSetting('startup_intro_enabled', checked ? 'true' : 'false');
                  setToast({
                    message: checked
                      ? 'Welcome intro enabled'
                      : 'Welcome intro disabled',
                    type: 'success'
                  });
                } catch (e) {
                  setToast({ message: 'Failed to update preference', type: 'error' });
                }
              }}
            />
          </div>

          {/* Update Source Folder */}
          <div className="space-y-2">
            <Label htmlFor="local-update-dir">Update Source Folder</Label>
            <p className="text-caption text-muted-foreground">
              Folder that holds locally-built <code>OmniFex-&lt;version&gt;-arm64.dmg</code> files.
              OmniFex scans this folder and offers an update when a newer version is present.
              Leave empty to disable update checks.
            </p>
            <div className="flex items-center gap-2">
              <Input
                id="local-update-dir"
                type="text"
                value={localUpdateDir}
                placeholder="/Users/you/Repos/omnifex/out/make"
                onChange={(e) => { setLocalUpdateDir(e.target.value); }}
                onBlur={() => saveLocalUpdateDir(localUpdateDir)}
                className="flex-1 font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  const picked = await pickFolder(localUpdateDir || undefined);
                  if (picked) {
                    setLocalUpdateDir(picked);
                    await saveLocalUpdateDir(picked);
                  }
                }}
              >
                Browse…
              </Button>
              {localUpdateDir && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    setLocalUpdateDir('');
                    await saveLocalUpdateDir('');
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
};
