import React, { useState, useEffect } from "react";
import {
  Check,
  Volume2,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
import {
  api,
  CLI_REVIEW_REPO_DIR_SETTING_KEY,
  CLI_AUTO_UPDATE_SETTING_KEY,
  type ClaudeInstallation,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { AutoRecapSettings } from "./AutoRecapSettings";
import { ClaudeVersionSelector } from "@/components/ClaudeVersionSelector";
import { useTheme } from "@/hooks";
import { useAppFont } from "@/contexts/AppFontContext";
import { useAutoScroll } from "@/contexts/AutoScrollContext";
import { useSessionGauges } from "@/contexts/SessionGaugesContext";
import {
  defaultValueForMode,
  resolveBudgetTokens,
  formatTokens,
} from "@/lib/contextPressure";
import { DEFAULT_CONTEXT_JUMP_TOKENS } from "@/lib/turnDelta";
import { APP_FONT_CHOICES } from "@/lib/typefaceCatalog";
import { TabPersistenceService } from "@/services/tabPersistence";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import type { ViewMode } from "@/lib/messageRenderingConfig";
import { TabIndicatorsEditor } from "./TabIndicatorsEditor";
import { TabDensityControl } from "./TabDensityControl";
import { TabMaxWidthControl } from "./TabMaxWidthControl";
import { useSaveStatus } from "./saveStatus";
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";
import {
  NOTIFICATION_SOUND_CHOICES,
  NOTIFICATION_SOUND_SETTING_KEYS,
  MOD_NOTIFICATIONS_SETTING_KEY,
  modNotificationsEnabled,
  DEFAULT_SUCCESS_SOUND,
  DEFAULT_ERROR_SOUND,
  normalizeNotificationSoundId,
  type NotificationSoundId,
} from "@/lib/notificationSounds";

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h4 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
}

const CHAT_FORMATS: { value: ViewMode; label: string }[] = [
  { value: "standard", label: "Standard" },
  { value: "expanded", label: "Expanded" },
];

export const GeneralSettings: React.FC = () => {
  const { track } = useSaveStatus();
  const { theme, setTheme } = useTheme();
  const { appFont, setAppFont, isLoading: appFontLoading } = useAppFont();
  const { config, setConfig } = useMessageRenderingConfig();
  const { followPx, setFollowPx } = useAutoScroll();
  const [followDraft, setFollowDraft] = useState(String(followPx));

  useEffect(() => {
    setFollowDraft(String(followPx));
  }, [followPx]);

  const commitFollowPx = (next: number) => {
    if (next === followPx) return;
    void track(setFollowPx(next));
  };
  const {
    contextPressure,
    setContextPressure,
    cacheTimerEnabled,
    setCacheTimerEnabled,
    contextJump,
    setContextJump,
  } = useSessionGauges();
  const [pressureDraft, setPressureDraft] = useState(String(contextPressure.value));
  useEffect(() => {
    setPressureDraft(String(contextPressure.value));
  }, [contextPressure.value]);

  const commitPressureValue = () => {
    const parsed = Number.parseInt(pressureDraft, 10);
    const next = Number.isFinite(parsed)
      ? parsed
      : defaultValueForMode(contextPressure.mode);
    if (next === contextPressure.value) return;
    void track(setContextPressure({ ...contextPressure, value: next }));
  };

  const [jumpDraft, setJumpDraft] = useState(String(contextJump.thresholdTokens));
  useEffect(() => {
    setJumpDraft(String(contextJump.thresholdTokens));
  }, [contextJump.thresholdTokens]);

  const commitJumpTokens = () => {
    const parsed = Number.parseInt(jumpDraft, 10);
    const thresholdTokens = Number.isFinite(parsed) ? parsed : DEFAULT_CONTEXT_JUMP_TOKENS;
    if (thresholdTokens === contextJump.thresholdTokens) return;
    void track(setContextJump({ ...contextJump, thresholdTokens }));
  };

  const pressureExplanation = (() => {
    const describe = (limit: number, label: string) => {
      const budget = resolveBudgetTokens(contextPressure, limit);
      return `${label}: amber at ${formatTokens(Math.floor(budget * 0.8))}, compact at ${formatTokens(budget)}`;
    };
    return `${describe(1_000_000, "1M session")} · ${describe(200_000, "200k session")}.`;
  })();

  const [cliReviewRepoDir, setCliReviewRepoDir] = useState('');
  // Reads `=== 'true'`, not `!== 'false'`: a missing setting must mean off.
  const [cliAutoUpdate, setCliAutoUpdate] = useState(false);

  const [currentBinaryPath, setCurrentBinaryPath] = useState<string | null>(null);

  const [tabPersistenceEnabled, setTabPersistenceEnabled] = useState(true);
  const [startupIntroEnabled, setStartupIntroEnabled] = useState(true);
  const [successSound, setSuccessSound] = useState<NotificationSoundId>(DEFAULT_SUCCESS_SOUND);
  const [errorSound, setErrorSound] = useState<NotificationSoundId>(DEFAULT_ERROR_SOUND);
  const [modNotifications, setModNotifications] = useState(true);

  useEffect(() => {
    setTabPersistenceEnabled(TabPersistenceService.isEnabled());
    logAndForget('general-settings:load-claude-binary-path', (async () => {
      setCurrentBinaryPath(await api.getClaudeBinaryPath());
    })());
    logAndForget('general-settings:iife', (async () => {
      const pref = await api.getSetting('startup_intro_enabled');
      setStartupIntroEnabled(pref === null ? true : pref === 'true');
      const successRaw = await api.getSetting(NOTIFICATION_SOUND_SETTING_KEYS.success);
      setSuccessSound(normalizeNotificationSoundId(successRaw, DEFAULT_SUCCESS_SOUND));
      const errorRaw = await api.getSetting(NOTIFICATION_SOUND_SETTING_KEYS.error);
      setErrorSound(normalizeNotificationSoundId(errorRaw, DEFAULT_ERROR_SOUND));
      setModNotifications(modNotificationsEnabled(await api.getSetting(MOD_NOTIFICATIONS_SETTING_KEY)));
      savedCliReviewRepoDir.current = (await api.getSetting(CLI_REVIEW_REPO_DIR_SETTING_KEY)) ?? '';
      setCliReviewRepoDir(savedCliReviewRepoDir.current);
      setCliAutoUpdate((await api.getSetting(CLI_AUTO_UPDATE_SETTING_KEY)) === 'true');
    })());
  }, []);

  const selectClaudeInstallation = (installation: ClaudeInstallation) => {
    if (installation.path === currentBinaryPath) return;
    setCurrentBinaryPath(installation.path);
    void track(api.setClaudeBinaryPath(installation.path));
  };

  const savedCliReviewRepoDir = React.useRef('');

  const saveCliReviewRepoDir = async (next: string) => {
    setCliReviewRepoDir(next);
    if (next === savedCliReviewRepoDir.current) return;
    savedCliReviewRepoDir.current = next;
    await track(api.saveSetting(CLI_REVIEW_REPO_DIR_SETTING_KEY, next));
  };


  const browseForCliReviewRepoDir = async () => {
    const paths = (await window.electronAPI.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select your OmniFex source checkout',
    })) as string[] | null;
    if (paths?.[0]) await saveCliReviewRepoDir(paths[0]);
  };

  const saveSound = async (
    kind: 'success' | 'error',
    next: NotificationSoundId,
  ) => {
    const key = NOTIFICATION_SOUND_SETTING_KEYS[kind];
    const saved = await track(api.saveSetting(key, next));
    if (saved && next !== 'none') {
      void api.previewNotificationSound(next);
    }
  };

  return (
    <Card className="p-6 space-y-6">
      <div>
        <h3 className="text-heading-4 mb-4">General Settings</h3>

        <div className="space-y-6">
          <SettingsSection title="Appearance">
            <div className="flex items-center justify-between">
              <div>
                <Label>Theme</Label>
                <p className="text-caption text-muted-foreground mt-1">
                  Choose your preferred color theme
                </p>
              </div>
              <div className="flex items-center gap-1 p-1 bg-muted/30 rounded-lg">
                <button
                  onClick={() => { void track(setTheme('gray')); }}
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
                  onClick={() => { void track(setTheme('light')); }}
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
                  onValueChange={(v) => { void track(setAppFont(v)); }}
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

            <div className="flex items-center justify-between">
              <div>
                <Label>Default chat view</Label>
                <p className="text-caption text-muted-foreground mt-1">
                  The view a new session opens in. Each session can still switch its own.
                </p>
              </div>
              <div
                role="radiogroup"
                aria-label="Default chat view"
                className="flex items-center gap-1 p-1 bg-muted/30 rounded-lg"
              >
                {CHAT_FORMATS.map((f) => {
                  const checked = config.defaultViewMode === f.value;
                  return (
                    <button
                      key={f.value}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      onClick={() => { void track(setConfig({ ...config, defaultViewMode: f.value })); }}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                        checked ? "bg-background shadow-sm" : "hover:bg-background/50",
                      )}
                    >
                      {checked && <Check className="h-3 w-3" />}
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </SettingsSection>

          <div className="border-t border-border" />
          <SettingsSection title="Tabs">
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
                  setTabPersistenceEnabled(checked);
                  void track(() => { TabPersistenceService.setEnabled(checked); });
                }}
              />
            </div>

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
                onCheckedChange={(checked) => {
                  setStartupIntroEnabled(checked);
                  void track(api.saveSetting('startup_intro_enabled', checked ? 'true' : 'false'));
                }}
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label>Tab strip</Label>
                <p className="text-caption text-muted-foreground mt-1">
                  Expanded puts the session name under the project name. Compact is
                  a single line — the session name moves to the hover tooltip.
                </p>
              </div>
              <TabDensityControl
                density={config.tabs.density}
                onChange={(density) => { void track(setConfig({ ...config, tabs: { ...config.tabs, density } })); }}
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label>Max tab width</Label>
                <p className="text-caption text-muted-foreground mt-1">
                  Tabs size to their names up to this width, then truncate with an
                  ellipsis.
                </p>
              </div>
              <TabMaxWidthControl
                maxWidth={config.tabs.maxWidth}
                onChange={(maxWidth) => { void track(setConfig({ ...config, tabs: { ...config.tabs, maxWidth } })); }}
              />
            </div>

            <div className="space-y-3">
              <TabIndicatorsEditor
                indicators={config.tabIndicators}
                onChange={(next) => { void track(setConfig({ ...config, tabIndicators: next })); }}
              />
            </div>
          </SettingsSection>

          <div className="border-t border-border" />
          <SettingsSection title="Chat">
            <div className="space-y-3">
              <div>
                <Label>Chat auto-scroll</Label>
                <p className="text-caption text-muted-foreground mt-1">
                  The chat follows new messages while you are within this
                  distance of the bottom. Scroll further up and it stops; scroll
                  back within it and it resumes. Default: 300px.
                </p>
              </div>

              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="autoscroll-follow" className="text-body-small">
                  Follow new messages within (px) of bottom
                </Label>
                <Input
                  id="autoscroll-follow"
                  type="number"
                  min={0}
                  step={50}
                  className="w-32"
                  value={followDraft}
                  onChange={(e) => setFollowDraft(e.target.value)}
                  onBlur={() => commitFollowPx(Number.parseInt(followDraft, 10) || 0)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
              </div>
            </div>

            <AutoRecapSettings />
          </SettingsSection>

          <div className="border-t border-border" />
          <SettingsSection title="Notifications">
            <div className="space-y-3">
              <div>
                <Label>Notification Sounds</Label>
                <p className="text-caption text-muted-foreground mt-1">
                  Choose what plays when a task finishes. Changing a sound
                  previews it; the test button replays the current choice.
                </p>
              </div>

              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="notif-sound-success" className="text-body-small">
                  Success sound
                </Label>
                <div className="flex items-center gap-2">
                  <div className="w-48">
                    <Select
                      value={successSound}
                      onValueChange={fireAndLog(
                        'general-settings:value-change',
                        (v) => {
                          const next = normalizeNotificationSoundId(v, DEFAULT_SUCCESS_SOUND);
                          setSuccessSound(next);
                          void saveSound('success', next);
                        },
                      )}
                    >
                      <SelectTrigger id="notif-sound-success">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {NOTIFICATION_SOUND_CHOICES.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={successSound === 'none'}
                    onClick={fireAndLog('general-settings:click', () =>
                      api.previewNotificationSound(successSound),
                    )}
                    title="Play test sound"
                    aria-label="Play test success sound"
                  >
                    <Volume2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="notif-sound-error" className="text-body-small">
                  Error sound
                </Label>
                <div className="flex items-center gap-2">
                  <div className="w-48">
                    <Select
                      value={errorSound}
                      onValueChange={fireAndLog(
                        'general-settings:value-change',
                        (v) => {
                          const next = normalizeNotificationSoundId(v, DEFAULT_ERROR_SOUND);
                          setErrorSound(next);
                          void saveSound('error', next);
                        },
                      )}
                    >
                      <SelectTrigger id="notif-sound-error">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {NOTIFICATION_SOUND_CHOICES.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={errorSound === 'none'}
                    onClick={fireAndLog('general-settings:click', () =>
                      api.previewNotificationSound(errorSound),
                    )}
                    title="Play test sound"
                    aria-label="Play test error sound"
                  >
                    <Volume2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label htmlFor="mod-notifications">Notifications from mods</Label>
                <p className="text-caption text-muted-foreground">
                  Let mods raise macOS notifications. Turning this off drops new
                  ones; ones already scheduled still fire.
                </p>
              </div>
              <Switch
                id="mod-notifications"
                checked={modNotifications}
                onCheckedChange={(checked) => {
                  setModNotifications(checked);
                  void track(api.saveSetting(MOD_NOTIFICATIONS_SETTING_KEY, checked ? 'true' : 'false'));
                }}
              />
            </div>
          </SettingsSection>

          <div className="border-t border-border" />
          <SettingsSection title="Context & cache">
            <div className="space-y-3">
              <div>
                <Label>Context budget</Label>
                <p className="text-caption text-muted-foreground mt-1">
                  Tints the session's context meter amber at 80% of your budget,
                  and raises a <code>/compact</code> prompt above the composer at
                  100%.
                </p>
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="context-pressure-enabled" className="text-body-small">
                  Warn when context fills up
                </Label>
                <Switch
                  id="context-pressure-enabled"
                  checked={contextPressure.enabled}
                  onCheckedChange={fireAndLog('general-settings:checked-change', (checked) => {
                    void track(setContextPressure({ ...contextPressure, enabled: checked }));
                  })}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <Label className="text-body-small">Budget measured in</Label>
                <div className="w-48">
                  <Select
                    value={contextPressure.mode}
                    disabled={!contextPressure.enabled}
                    onValueChange={fireAndLog('general-settings:value-change', (v) => {
                      const mode = v === 'percent' ? 'percent' : 'tokens';
                      // Swap in that mode's default: the old number means nothing in the new unit.
                      void track(setContextPressure({
                        ...contextPressure,
                        mode,
                        value: defaultValueForMode(mode),
                      }));
                    })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tokens">Absolute tokens</SelectItem>
                      <SelectItem value="percent">Percent of window</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="context-pressure-value" className="text-body-small">
                  {contextPressure.mode === 'percent'
                    ? 'Compact threshold (% of window)'
                    : 'Compact threshold (tokens)'}
                </Label>
                <Input
                  id="context-pressure-value"
                  type="number"
                  min={contextPressure.mode === 'percent' ? 1 : 1000}
                  max={contextPressure.mode === 'percent' ? 100 : undefined}
                  step={contextPressure.mode === 'percent' ? 5 : 10_000}
                  className="w-32"
                  disabled={!contextPressure.enabled}
                  value={pressureDraft}
                  onChange={(e) => setPressureDraft(e.target.value)}
                  onBlur={commitPressureValue}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
              </div>

              <p className="text-caption text-muted-foreground">
                {pressureExplanation}
              </p>

              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label htmlFor="context-jump-enabled">Track per-turn context growth</Label>
                  <p className="text-caption text-muted-foreground">
                    Logs what each turn added to context, in the transcript gutter
                    and the session widget, and highlights any turn past the
                    threshold below — usually a skill or file load. A turn-count
                    habit can’t catch these; only a delta can.
                  </p>
                </div>
                <Switch
                  id="context-jump-enabled"
                  checked={contextJump.enabled}
                  onCheckedChange={fireAndLog('general-settings:checked-change', (checked) => {
                    void track(setContextJump({ ...contextJump, enabled: checked }));
                  })}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="context-jump-tokens" className="text-body-small">
                  Flag turns adding more than (tokens)
                </Label>
                <Input
                  id="context-jump-tokens"
                  type="number"
                  min={1000}
                  step={10_000}
                  className="w-32"
                  disabled={!contextJump.enabled}
                  value={jumpDraft}
                  onChange={(e) => setJumpDraft(e.target.value)}
                  onBlur={commitJumpTokens}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label htmlFor="cache-timer-enabled">Prompt cache countdown</Label>
                  <p className="text-caption text-muted-foreground">
                    Shows how long the prompt cache has left under the context
                    gauge, and flags the tab as it runs out. The cache TTL is read
                    from what the CLI actually reported on the last turn.
                  </p>
                </div>
                <Switch
                  id="cache-timer-enabled"
                  checked={cacheTimerEnabled}
                  onCheckedChange={fireAndLog('general-settings:checked-change', (checked) => {
                    void track(setCacheTimerEnabled(checked));
                  })}
                />
              </div>
            </div>
          </SettingsSection>

          <div className="border-t border-border" />
          <SettingsSection title="Claude Code">
            <div className="space-y-3">
              <ClaudeVersionSelector
                selectedPath={currentBinaryPath}
                onSelect={selectClaudeInstallation}
                simplified={true}
                // Saved on pick, so never auto-pick: a late auto-pick overwrote the saved path.
                autoSelect={false}
              />
            </div>

            {/* Off by default: it mutates a toolchain OmniFex doesn't own. */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="cli-auto-update">Auto-update Claude Code on launch</Label>
                <p className="text-caption text-muted-foreground mt-1">
                  Run <code>claude update</code> at startup when a newer release is
                  available. The CLI only self-updates when launched in a terminal,
                  so OmniFex-only use otherwise falls behind.
                </p>
              </div>
              <Switch
                id="cli-auto-update"
                checked={cliAutoUpdate}
                onCheckedChange={fireAndLog('general-settings:checked-change', (checked) => {
                  setCliAutoUpdate(checked);
                  void track(api.saveSetting(CLI_AUTO_UPDATE_SETTING_KEY, checked ? 'true' : 'false'));
                })}
              />
            </div>

            <div className="space-y-3">
              <div>
                <Label htmlFor="cli-review-repo-dir">OmniFex checkout</Label>
                <p className="text-caption text-muted-foreground mt-1">
                  Where to run the Claude Code changelog review when you click the
                  drift warning in the Updates popover. Leave blank to auto-detect.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="cli-review-repo-dir"
                  placeholder="Auto-detect"
                  value={cliReviewRepoDir}
                  onChange={(e) => { setCliReviewRepoDir(e.target.value); }}
                  onBlur={fireAndLog('general-settings:blur', () =>
                    saveCliReviewRepoDir(cliReviewRepoDir.trim()),
                  )}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={fireAndLog('general-settings:click', browseForCliReviewRepoDir)}
                >
                  Browse…
                </Button>
              </div>
            </div>
          </SettingsSection>
        </div>
      </div>
    </Card>
  );
};
