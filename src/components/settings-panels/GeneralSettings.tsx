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
import { api, type ClaudeInstallation } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ClaudeVersionSelector } from "@/components/ClaudeVersionSelector";
import { useTheme } from "@/hooks";
import { TabPersistenceService } from "@/services/tabPersistence";
import type { SettingsPanelProps } from "./types";

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
  settings,
  updateSetting,
  setToast,
  currentBinaryPath,
  binaryPathChanged,
  onClaudeInstallationSelect,
}) => {
  const { theme, setTheme, customColors, setCustomColors } = useTheme();
  const [tabPersistenceEnabled, setTabPersistenceEnabled] = useState(true);
  const [startupIntroEnabled, setStartupIntroEnabled] = useState(true);
  // The directory the updater scans for newer GreyChrist-<semver>-arm64.dmg
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
                onClick={() => setTheme('dark')}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                  theme === 'dark'
                    ? "bg-background shadow-sm"
                    : "hover:bg-background/50"
                )}
              >
                {theme === 'dark' && <Check className="h-3 w-3" />}
                Dark
              </button>
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
              <button
                onClick={() => setTheme('custom')}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                  theme === 'custom'
                    ? "bg-background shadow-sm"
                    : "hover:bg-background/50"
                )}
              >
                {theme === 'custom' && <Check className="h-3 w-3" />}
                Custom
              </button>
            </div>
          </div>

          {/* Custom Color Editor */}
          {theme === 'custom' && (
            <div className="space-y-4 p-4 border rounded-lg bg-muted/20">
              <h4 className="text-label">Custom Theme Colors</h4>

              <div className="grid grid-cols-2 gap-4">
                {/* Background Color */}
                <div className="space-y-2">
                  <Label htmlFor="color-background" className="text-caption">Background</Label>
                  <div className="flex gap-2">
                    <Input
                      id="color-background"
                      type="text"
                      value={customColors.background}
                      onChange={(e) => setCustomColors({ background: e.target.value })}
                      placeholder="oklch(0.12 0.01 240)"
                      className="font-mono text-xs"
                    />
                    <div
                      className="w-10 h-10 rounded border"
                      style={{ backgroundColor: customColors.background }}
                    />
                  </div>
                </div>

                {/* Foreground Color */}
                <div className="space-y-2">
                  <Label htmlFor="color-foreground" className="text-caption">Foreground</Label>
                  <div className="flex gap-2">
                    <Input
                      id="color-foreground"
                      type="text"
                      value={customColors.foreground}
                      onChange={(e) => setCustomColors({ foreground: e.target.value })}
                      placeholder="oklch(0.98 0.01 240)"
                      className="font-mono text-xs"
                    />
                    <div
                      className="w-10 h-10 rounded border"
                      style={{ backgroundColor: customColors.foreground }}
                    />
                  </div>
                </div>

                {/* Primary Color */}
                <div className="space-y-2">
                  <Label htmlFor="color-primary" className="text-caption">Primary</Label>
                  <div className="flex gap-2">
                    <Input
                      id="color-primary"
                      type="text"
                      value={customColors.primary}
                      onChange={(e) => setCustomColors({ primary: e.target.value })}
                      placeholder="oklch(0.98 0.01 240)"
                      className="font-mono text-xs"
                    />
                    <div
                      className="w-10 h-10 rounded border"
                      style={{ backgroundColor: customColors.primary }}
                    />
                  </div>
                </div>

                {/* Card Color */}
                <div className="space-y-2">
                  <Label htmlFor="color-card" className="text-caption">Card</Label>
                  <div className="flex gap-2">
                    <Input
                      id="color-card"
                      type="text"
                      value={customColors.card}
                      onChange={(e) => setCustomColors({ card: e.target.value })}
                      placeholder="oklch(0.14 0.01 240)"
                      className="font-mono text-xs"
                    />
                    <div
                      className="w-10 h-10 rounded border"
                      style={{ backgroundColor: customColors.card }}
                    />
                  </div>
                </div>

                {/* Accent Color */}
                <div className="space-y-2">
                  <Label htmlFor="color-accent" className="text-caption">Accent</Label>
                  <div className="flex gap-2">
                    <Input
                      id="color-accent"
                      type="text"
                      value={customColors.accent}
                      onChange={(e) => setCustomColors({ accent: e.target.value })}
                      placeholder="oklch(0.16 0.01 240)"
                      className="font-mono text-xs"
                    />
                    <div
                      className="w-10 h-10 rounded border"
                      style={{ backgroundColor: customColors.accent }}
                    />
                  </div>
                </div>

                {/* Destructive Color */}
                <div className="space-y-2">
                  <Label htmlFor="color-destructive" className="text-caption">Destructive</Label>
                  <div className="flex gap-2">
                    <Input
                      id="color-destructive"
                      type="text"
                      value={customColors.destructive}
                      onChange={(e) => setCustomColors({ destructive: e.target.value })}
                      placeholder="oklch(0.6 0.2 25)"
                      className="font-mono text-xs"
                    />
                    <div
                      className="w-10 h-10 rounded border"
                      style={{ backgroundColor: customColors.destructive }}
                    />
                  </div>
                </div>
              </div>

              <p className="text-caption text-muted-foreground">
                Use CSS color values (hex, rgb, oklch, etc.). Changes apply immediately.
              </p>
            </div>
          )}

          {/* Include Co-authored By */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5 flex-1">
              <Label htmlFor="coauthored">Include "Co-authored by Claude"</Label>
              <p className="text-caption text-muted-foreground">
                Add Claude attribution to git commits and pull requests
              </p>
            </div>
            <Switch
              id="coauthored"
              checked={settings?.includeCoAuthoredBy === true}
              onCheckedChange={(checked) => updateSetting("includeCoAuthoredBy", checked)}
            />
          </div>

          {/* Verbose Output */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5 flex-1">
              <Label htmlFor="verbose">Verbose Output</Label>
              <p className="text-caption text-muted-foreground">
                Show full bash and command outputs
              </p>
            </div>
            <Switch
              id="verbose"
              checked={settings?.verbose === true}
              onCheckedChange={(checked) => updateSetting("verbose", checked)}
            />
          </div>

          {/* Cleanup Period */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <Label htmlFor="cleanup">Chat Transcript Retention (days)</Label>
                <p className="text-caption text-muted-foreground mt-1">
                  How long to retain chat transcripts locally (default: 30 days)
                </p>
              </div>
              <Input
                id="cleanup"
                type="number"
                min="1"
                placeholder="30"
                value={settings?.cleanupPeriodDays || ""}
                onChange={(e) => {
                  const value = e.target.value ? parseInt(e.target.value) : undefined;
                  updateSetting("cleanupPeriodDays", value);
                }}
                className="w-24"
              />
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
              Folder that holds locally-built <code>GreyChrist-&lt;version&gt;-arm64.dmg</code> files.
              GreyChrist scans this folder and offers an update when a newer version is present.
              Leave empty to disable update checks.
            </p>
            <div className="flex items-center gap-2">
              <Input
                id="local-update-dir"
                type="text"
                value={localUpdateDir}
                placeholder="/Users/you/Repos/greychrist/out/make"
                onChange={(e) => setLocalUpdateDir(e.target.value)}
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
