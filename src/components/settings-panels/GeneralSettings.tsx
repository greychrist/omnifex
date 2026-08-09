import React, { useState, useEffect } from "react";
import {
  AlertCircle,
  Check,
  RotateCcw,
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
import { api, CLI_REVIEW_REPO_DIR_SETTING_KEY, type ClaudeInstallation } from "@/lib/api";
import {
  CLI_REVIEW_PROMPT_SETTING_KEY,
  DEFAULT_CLI_REVIEW_PROMPT,
} from "@/lib/cliReviewPrompt";
import { cn } from "@/lib/utils";
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
import { TabIndicatorsEditor } from "./TabIndicatorsEditor";
import type { SettingsPanelProps } from "./types";
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";
import {
  NOTIFICATION_SOUND_CHOICES,
  NOTIFICATION_SOUND_SETTING_KEYS,
  DEFAULT_SUCCESS_SOUND,
  DEFAULT_ERROR_SOUND,
  normalizeNotificationSoundId,
  type NotificationSoundId,
} from "@/lib/notificationSounds";

// This panel no longer reads from `<configDir>/settings.json`. The three
// keys it used to expose (`includeCoAuthoredBy`, `verbose`,
// `cleanupPeriodDays`) were removed in May 2026 — the first is deprecated
// upstream, the second isn't in current Claude Code docs, and the third is
// load-bearing-but-rarely-tuned (Claude defaults to 30 days). Anyone who
// still wants to tune those can edit the per-account settings.json directly.

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
  const { config, setConfig } = useMessageRenderingConfig();
  const {
    reengagePx,
    disengagePx,
    setThresholds: setAutoScrollThresholds,
  } = useAutoScroll();
  // Local draft strings so typing stays smooth; committed to the context
  // (which persists + clamps) on blur or Enter. Re-seeded whenever the
  // context values change (e.g. after the clamp adjusts disengage up).
  const [reengageDraft, setReengageDraft] = useState(String(reengagePx));
  const [disengageDraft, setDisengageDraft] = useState(String(disengagePx));

  useEffect(() => {
    setReengageDraft(String(reengagePx));
  }, [reengagePx]);
  useEffect(() => {
    setDisengageDraft(String(disengagePx));
  }, [disengagePx]);

  const commitAutoScroll = (next: { reengagePx: number; disengagePx: number }) => {
    void setAutoScrollThresholds(next);
    setToast({ message: "Auto-scroll thresholds updated", type: "success" });
  };
  // Context-pressure budget + cache countdown. Same draft-string pattern as the
  // auto-scroll inputs above: typing stays smooth, the value commits on blur or
  // Enter (where the context clamps and persists it).
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
    void setContextPressure({ ...contextPressure, value: next });
    setToast({ message: "Compact threshold updated", type: "success" });
  };

  const [jumpDraft, setJumpDraft] = useState(String(contextJump.thresholdTokens));
  useEffect(() => {
    setJumpDraft(String(contextJump.thresholdTokens));
  }, [contextJump.thresholdTokens]);

  const commitJumpTokens = () => {
    const parsed = Number.parseInt(jumpDraft, 10);
    void setContextJump({
      ...contextJump,
      thresholdTokens: Number.isFinite(parsed) ? parsed : DEFAULT_CONTEXT_JUMP_TOKENS,
    });
    setToast({ message: "Jump threshold updated", type: "success" });
  };

  // Spell out what the setting resolves to on both window sizes, so the
  // clamp on absolute budgets larger than the window isn't a surprise.
  const pressureExplanation = (() => {
    const describe = (limit: number, label: string) => {
      const budget = resolveBudgetTokens(contextPressure, limit);
      return `${label}: amber at ${formatTokens(Math.floor(budget * 0.8))}, red at ${formatTokens(budget)}`;
    };
    return `${describe(1_000_000, "1M session")} · ${describe(200_000, "200k session")}.`;
  })();

  // OmniFex checkout the Updates popover's changelog-review launch runs in.
  // Empty means "discover it" — the dev cwd, else whichever known project is
  // an OmniFex checkout — which is the normal state; this is an override for
  // when discovery picks the wrong one or finds nothing.
  const [cliReviewRepoDir, setCliReviewRepoDir] = useState('');

  // The prompt that same launch starts its session with. Empty means "use the
  // shipped default", which is the normal state.
  const [cliReviewPrompt, setCliReviewPrompt] = useState('');

  const [tabPersistenceEnabled, setTabPersistenceEnabled] = useState(true);
  const [startupIntroEnabled, setStartupIntroEnabled] = useState(true);
  const [successSound, setSuccessSound] = useState<NotificationSoundId>(DEFAULT_SUCCESS_SOUND);
  const [errorSound, setErrorSound] = useState<NotificationSoundId>(DEFAULT_ERROR_SOUND);

  useEffect(() => {
    setTabPersistenceEnabled(TabPersistenceService.isEnabled());
    logAndForget('general-settings:iife', (async () => {
      const pref = await api.getSetting('startup_intro_enabled');
      setStartupIntroEnabled(pref === null ? true : pref === 'true');
      const successRaw = await api.getSetting(NOTIFICATION_SOUND_SETTING_KEYS.success);
      setSuccessSound(normalizeNotificationSoundId(successRaw, DEFAULT_SUCCESS_SOUND));
      const errorRaw = await api.getSetting(NOTIFICATION_SOUND_SETTING_KEYS.error);
      setErrorSound(normalizeNotificationSoundId(errorRaw, DEFAULT_ERROR_SOUND));
      setCliReviewRepoDir((await api.getSetting(CLI_REVIEW_REPO_DIR_SETTING_KEY)) ?? '');
      setCliReviewPrompt((await api.getSetting(CLI_REVIEW_PROMPT_SETTING_KEY)) ?? '');
    })());
  }, []);

  const saveCliReviewRepoDir = async (next: string) => {
    setCliReviewRepoDir(next);
    try {
      await api.saveSetting(CLI_REVIEW_REPO_DIR_SETTING_KEY, next);
      setToast({
        message: next ? 'OmniFex checkout updated' : 'OmniFex checkout cleared — using auto-detection',
        type: 'success',
      });
    } catch {
      setToast({ message: 'Failed to save OmniFex checkout', type: 'error' });
    }
  };

  const saveCliReviewPrompt = async (next: string) => {
    // Blank is meaningful: it clears the override and restores the built-in.
    const value = next.trim() ? next : '';
    setCliReviewPrompt(value);
    try {
      await api.saveSetting(CLI_REVIEW_PROMPT_SETTING_KEY, value);
      setToast({
        message: value ? 'Review prompt updated' : 'Review prompt cleared — using the built-in',
        type: 'success',
      });
    } catch {
      setToast({ message: 'Failed to save review prompt', type: 'error' });
    }
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
    try {
      await api.saveSetting(key, next);
      if (next !== 'none') {
        // Fire-and-forget preview so the user hears the change immediately.
        void api.previewNotificationSound(next);
      }
      setToast({
        message: `${kind === 'success' ? 'Success' : 'Error'} sound updated`,
        type: 'success',
      });
    } catch {
      setToast({ message: 'Failed to save notification sound', type: 'error' });
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
                onClick={fireAndLog('general-settings:click', () => setTheme('gray'))}
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
                onClick={fireAndLog('general-settings:click', () => setTheme('light'))}
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
                onValueChange={fireAndLog('general-settings:value-change', (v) => setAppFont(v))}
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
              onCheckedChange={fireAndLog('general-settings:checked-change', async (checked) => {
                setStartupIntroEnabled(checked);
                try {
                  await api.saveSetting('startup_intro_enabled', checked ? 'true' : 'false');
                  setToast({
                    message: checked
                      ? 'Welcome intro enabled'
                      : 'Welcome intro disabled',
                    type: 'success'
                  });
                } catch {
                  setToast({ message: 'Failed to update preference', type: 'error' });
                }
              })}
            />
          </div>

          {/* Chat auto-scroll thresholds — how the transcript decides whether
              to keep sticking to the bottom while messages stream. The chat
              stops auto-scrolling once you scroll up past "stop" px, and
              resumes once you scroll back within "resume" px of the bottom.
              The gap between them is a dead zone that prevents flapping.
              Persisted as `autoscroll_reengage_px` / `autoscroll_disengage_px`
              and applied live to open chats (see AutoScrollContext). */}
          <div className="border-t border-border pt-4 mt-2" />
          <div className="space-y-3">
            <div>
              <Label>Chat auto-scroll</Label>
              <p className="text-caption text-muted-foreground mt-1">
                How far you can scroll up before the chat stops following new
                messages. Larger “stop” = stickier (more aggressive). Defaults:
                resume 200px, stop 400px.
              </p>
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="autoscroll-disengage" className="text-body-small">
                Stop following after scrolling up (px)
              </Label>
              <Input
                id="autoscroll-disengage"
                type="number"
                min={0}
                step={50}
                className="w-32"
                value={disengageDraft}
                onChange={(e) => setDisengageDraft(e.target.value)}
                onBlur={() =>
                  commitAutoScroll({
                    reengagePx: Number.parseInt(reengageDraft, 10) || 0,
                    disengagePx: Number.parseInt(disengageDraft, 10) || 0,
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="autoscroll-reengage" className="text-body-small">
                Resume following within (px) of bottom
              </Label>
              <Input
                id="autoscroll-reengage"
                type="number"
                min={0}
                step={50}
                className="w-32"
                value={reengageDraft}
                onChange={(e) => setReengageDraft(e.target.value)}
                onBlur={() =>
                  commitAutoScroll({
                    reengagePx: Number.parseInt(reengageDraft, 10) || 0,
                    disengagePx: Number.parseInt(disengageDraft, 10) || 0,
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </div>
          </div>

          {/* Notification Sounds — pick what plays when a task completes
              (success) and when one fails (error). Choices persist as
              `notification_sound_success` / `notification_sound_error` in
              app_settings and take effect on the next notification without
              a restart. Selecting "No sound" makes the OS notification
              silent and skips afplay while the window is focused. */}
          <div className="border-t border-border pt-4 mt-2" />
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

          {/* Session gauges — the context-pressure banner and the prompt-cache
              countdown. Both persist in app_settings and apply live to open
              sessions (see SessionGaugesContext). */}
          <div className="border-t border-border pt-4 mt-2" />
          <div className="space-y-3">
            <div>
              <Label>Context pressure banner</Label>
              <p className="text-caption text-muted-foreground mt-1">
                Shows a banner across the top of a session once its context
                passes your budget. Click the banner to run <code>/compact</code>.
                Amber at 80% of the budget, red at 100%.
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
                  void setContextPressure({ ...contextPressure, enabled: checked });
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
                    // Swap in that mode's default rather than reinterpreting the
                    // old number — 250000 percent, or 80 tokens, are nonsense.
                    void setContextPressure({
                      ...contextPressure,
                      mode,
                      value: defaultValueForMode(mode),
                    });
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
                <Label htmlFor="context-jump-enabled">Flag large single-turn jumps</Label>
                <p className="text-caption text-muted-foreground">
                  Notes when one turn adds a lot of context at once — a skill or
                  file load. A turn-count habit can’t catch these; only a delta can.
                </p>
              </div>
              <Switch
                id="context-jump-enabled"
                checked={contextJump.enabled}
                onCheckedChange={fireAndLog('general-settings:checked-change', (checked) => {
                  void setContextJump({ ...contextJump, enabled: checked });
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
                  void setCacheTimerEnabled(checked);
                })}
              />
            </div>
          </div>

          {/* Where the Updates popover's "Claude Code is ahead of the …
              changelog" warning launches its review session. Persisted as
              `cli_review_repo_dir`; blank falls back to auto-detection. */}
          <div className="border-t border-border pt-4 mt-2" />
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

          {/* The prompt that review session is started with. Shipped as a
              constant so it works on a fresh clone; persisted override lives
              in `cliReview.promptTemplate`. */}
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <Label htmlFor="cli-review-prompt">Changelog review prompt</Label>
                <p className="text-caption text-muted-foreground mt-1">
                  What that session is asked to do. <code>{'{reviewedVersion}'}</code> and{' '}
                  <code>{'{installedVersion}'}</code> are filled in with the range that
                  drifted. Leave blank to use the built-in prompt.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={fireAndLog('general-settings:click', () =>
                  saveCliReviewPrompt(DEFAULT_CLI_REVIEW_PROMPT),
                )}
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                Reset to default
              </Button>
            </div>
            <textarea
              id="cli-review-prompt"
              value={cliReviewPrompt}
              placeholder="Using the built-in prompt"
              spellCheck={false}
              rows={10}
              onChange={(e) => { setCliReviewPrompt(e.target.value); }}
              onBlur={fireAndLog('general-settings:blur', () =>
                saveCliReviewPrompt(cliReviewPrompt),
              )}
              className="w-full rounded-md border border-border bg-background p-2 font-mono text-xs outline-none focus:border-white/30"
            />
          </div>

          {/* Tab status indicators — the per-tab glyphs in the tab strip. */}
          <div className="space-y-3 border-t border-border/50 pt-4">
            <TabIndicatorsEditor
              indicators={config.tabIndicators}
              palette={config.palette}
              onChange={(next) => { setConfig({ ...config, tabIndicators: next }); }}
            />
          </div>

        </div>
      </div>
    </Card>
  );
};
