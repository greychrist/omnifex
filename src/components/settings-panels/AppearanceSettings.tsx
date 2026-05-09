import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RotateCcw, Upload, Save, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  createDefaultConfig,
  parseConfig,
  serializeConfig,
  DEFAULT_KINDS,
  type MessageRenderingConfig,
  type MessageKindConfig,
  type Palette,
  type PaletteEntry,
  type PaletteName,
  type Typography,
} from "@/lib/messageRenderingConfig";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { MessageKindTree } from "./appearance/MessageKindTree";
import { KindEditor } from "./appearance/KindEditor";
import { SamplePreview } from "./appearance/SamplePreview";
import { TurnPreview } from "./appearance/TurnPreview";
import { PaletteEditor } from "./appearance/PaletteEditor";
import { TypographyEditor } from "./appearance/TypographyEditor";
import { AppFontPicker } from "./AppFontPicker";
import type { SettingsPanelProps } from "./types";
import { cn } from "@/lib/utils";

const USER_DEFAULT_KEY = "message_rendering_config_user_default";

type AppearanceSettingsProps = Pick<SettingsPanelProps, "setToast">;

const FIRST_KIND_ID = "user.prompt";

interface FilterRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

const FilterRow: React.FC<FilterRowProps> = ({ label, description, checked, onChange }) => (
  <div className="flex items-start justify-between gap-4">
    <div className="space-y-0.5 flex-1">
      <Label>{label}</Label>
      <p className="text-caption text-muted-foreground">{description}</p>
    </div>
    <Switch checked={checked} onCheckedChange={onChange} />
  </div>
);

export const AppearanceSettings: React.FC<AppearanceSettingsProps> = ({ setToast }) => {
  const { config, setConfig: commitConfig } = useMessageRenderingConfig();
  const [selectedId, setSelectedId] = useState<string>(FIRST_KIND_ID);
  const [previewMode, setPreviewMode] = useState<"compact" | "verbose">(config.defaultViewMode);
  const [hasUserDefault, setHasUserDefault] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const saveToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load user-default presence on mount so the "Reset to my default" button
  // only enables once the user has actually saved a personal default.
  useEffect(() => {
    api
      .getSetting(USER_DEFAULT_KEY)
      .then((raw) => setHasUserDefault(!!raw))
      .catch(() => setHasUserDefault(false));
  }, []);

  // Debounced "Saved" toast: every mutate resets the timer; 800ms of quiet
  // flushes one toast. Prevents a flood during rapid color-picker or slider
  // edits while still surfacing that autosave happened.
  const scheduleSavedToast = useCallback(() => {
    if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current);
    saveToastTimerRef.current = setTimeout(() => {
      setToast({ message: "Appearance saved", type: "success" });
      saveToastTimerRef.current = null;
    }, 800);
  }, [setToast]);

  useEffect(() => {
    return () => {
      if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current);
    };
  }, []);

  // Keep the local preview toggle in sync when the persisted default mode changes.
  useEffect(() => {
    setPreviewMode(config.defaultViewMode);
  }, [config.defaultViewMode]);

  const mutate = useCallback(
    (producer: (prev: MessageRenderingConfig) => MessageRenderingConfig) => {
      commitConfig(producer(config));
      scheduleSavedToast();
    },
    [config, commitConfig, scheduleSavedToast],
  );

  const setTypography = useCallback(
    (next: Typography) => {
      mutate((prev) => ({ ...prev, typography: next }));
    },
    [mutate],
  );

  const saveAsUserDefault = useCallback(async () => {
    try {
      await api.saveSetting(USER_DEFAULT_KEY, serializeConfig(config));
      setHasUserDefault(true);
      setToast({ message: "Saved current appearance as your default", type: "success" });
    } catch {
      setToast({ message: "Failed to save default", type: "error" });
    }
  }, [config, setToast]);

  const resetToUserDefault = useCallback(async () => {
    try {
      const raw = await api.getSetting(USER_DEFAULT_KEY);
      if (!raw) {
        setToast({ message: "No personal default saved yet", type: "error" });
        return;
      }
      commitConfig(parseConfig(raw));
      setToast({ message: "Restored your saved default", type: "success" });
    } catch {
      setToast({ message: "Failed to restore default", type: "error" });
    }
  }, [commitConfig, setToast]);

  const selectedKind = config.kinds[selectedId] ?? config.kinds[FIRST_KIND_ID];

  const updateKind = useCallback(
    (id: string, patch: Partial<MessageKindConfig>) => {
      mutate((prev) => ({
        ...prev,
        kinds: { ...prev.kinds, [id]: { ...prev.kinds[id], ...patch } },
      }));
    },
    [mutate],
  );

  const resetKind = useCallback(
    (id: string) => {
      const def = DEFAULT_KINDS.find((k) => k.id === id);
      if (!def) return;
      mutate((prev) => ({ ...prev, kinds: { ...prev.kinds, [id]: { ...def } } }));
      setToast({ message: `Reset "${def.label}" to default`, type: "success" });
    },
    [mutate, setToast],
  );

  const updatePalette = useCallback(
    (name: PaletteName, patch: Partial<PaletteEntry>) => {
      mutate((prev) => {
        const nextPalette: Palette = {
          ...prev.palette,
          [name]: { ...prev.palette[name], ...patch },
        };
        return { ...prev, palette: nextPalette };
      });
    },
    [mutate],
  );

  const setDefaultViewMode = useCallback(
    (mode: "compact" | "verbose") => {
      mutate((prev) => ({ ...prev, defaultViewMode: mode }));
    },
    [mutate],
  );

  const resetAll = useCallback(() => {
    if (!window.confirm("Reset all appearance settings to defaults? This cannot be undone.")) {
      return;
    }
    commitConfig(createDefaultConfig());
    setToast({ message: "Appearance settings reset to defaults", type: "success" });
  }, [commitConfig, setToast]);

  const exportConfig = useCallback(() => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "omnifex-appearance.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [config]);

  const importConfig = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        const imported = parseConfig(text);
        commitConfig(imported);
        setPreviewMode(imported.defaultViewMode);
        setToast({ message: `Imported ${file.name}`, type: "success" });
      } catch {
        setToast({ message: "Failed to import config", type: "error" });
      }
    },
    [setToast],
  );

  const hardFiltersChecked = useMemo(
    () => ({
      dropMeta: config.hardFilters.dropMeta,
      dropTaskLifecycle: config.hardFilters.dropTaskLifecycle,
      dropEmptyUser: config.hardFilters.dropEmptyUser,
      dropHookLifecycle: config.hardFilters.dropHookLifecycle,
    }),
    [config.hardFilters],
  );

  const setHardFilter = (key: keyof typeof hardFiltersChecked, value: boolean) => {
    mutate((prev) => ({
      ...prev,
      hardFilters: { ...prev.hardFilters, [key]: value },
    }));
  };

  const setDebugOption = (key: "showCardKindLabel", value: boolean) => {
    mutate((prev) => ({
      ...prev,
      debug: { ...prev.debug, [key]: value },
    }));
  };

  return (
    <div className="space-y-6">
      {/* App font */}
      <Card className="p-6">
        <AppFontPicker />
      </Card>

      {/* Master-detail: tree + editor */}
      <Card className="p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="text-heading-4">Message kinds</h3>
            <p className="text-caption text-muted-foreground mt-1">
              Choose a kind on the left to edit its icon, accent color, header, and
              compact-mode visibility.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)] gap-6">
          <div className="lg:border-r lg:pr-4 lg:border-border">
            <MessageKindTree
              config={config}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>

          <div className="min-w-0 space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Sample</Label>
                <span className="text-caption text-muted-foreground">
                  Live preview — reflects your edits immediately.
                </span>
              </div>
              <div className="rounded-md border border-border bg-background p-4">
                <SamplePreview kind={selectedKind} palette={config.palette} />
              </div>
            </div>

            <KindEditor
              kind={selectedKind}
              palette={config.palette}
              typography={config.typography}
              onChange={(patch) => updateKind(selectedKind.id, patch)}
              onResetKind={() => resetKind(selectedKind.id)}
            />
          </div>
        </div>
      </Card>

      {/* Full-turn compact/verbose preview */}
      <Card className="p-6 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-heading-4">Turn preview</h3>
            <p className="text-caption text-muted-foreground mt-1">
              See what a full turn looks like in compact vs. verbose mode.
            </p>
          </div>
          <div className="flex items-center gap-1 p-1 bg-muted/30 rounded-lg">
            {(["verbose", "compact"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setPreviewMode(m)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-all capitalize",
                  previewMode === m ? "bg-background shadow-sm" : "hover:bg-background/50",
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-md border border-border bg-background p-4">
          <TurnPreview config={config} mode={previewMode} />
        </div>
      </Card>

      {/* Typography */}
      <Card className="p-6">
        <TypographyEditor typography={config.typography} onChange={setTypography} />
      </Card>

      {/* Global */}
      <Card className="p-6 space-y-6">
        <div>
          <h3 className="text-heading-4">Global</h3>
          <p className="text-caption text-muted-foreground mt-1">
            Defaults and hard filters that apply to every session.
          </p>
        </div>

        {/* Default view mode */}
        <div className="flex items-center justify-between">
          <div>
            <Label>Default view mode</Label>
            <p className="text-caption text-muted-foreground mt-1">
              Initial view when a session opens.
            </p>
          </div>
          <div className="flex items-center gap-1 p-1 bg-muted/30 rounded-lg">
            {(["verbose", "compact"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setDefaultViewMode(m)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-all capitalize",
                  config.defaultViewMode === m
                    ? "bg-background shadow-sm"
                    : "hover:bg-background/50",
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Hard filters */}
        <div className="space-y-3 pt-4 border-t border-border">
          <div>
            <Label>Hard filters</Label>
            <p className="text-caption text-muted-foreground mt-1">
              Messages dropped before rendering. Turn off for debugging only.
            </p>
          </div>
          <FilterRow
            label="Drop meta markers"
            description="Internal SDK markers with no user value."
            checked={hardFiltersChecked.dropMeta}
            onChange={(v) => setHardFilter("dropMeta", v)}
          />
          <FilterRow
            label="Drop task lifecycle events"
            description="Subagent task_started / task_progress events (rendered in SubagentBar)."
            checked={hardFiltersChecked.dropTaskLifecycle}
            onChange={(v) => setHardFilter("dropTaskLifecycle", v)}
          />
          <FilterRow
            label="Drop empty user messages"
            description="Placeholder user messages from the SDK with no content."
            checked={hardFiltersChecked.dropEmptyUser}
            onChange={(v) => setHardFilter("dropEmptyUser", v)}
          />
          <FilterRow
            label="Drop hook lifecycle events"
            description="SDK hook_started / hook_response / user_prompt_submit notices. Plumbing — turn off only to debug hook behavior."
            checked={hardFiltersChecked.dropHookLifecycle}
            onChange={(v) => setHardFilter("dropHookLifecycle", v)}
          />
        </div>

        {/* Debug */}
        <div className="space-y-3 pt-4 border-t border-border">
          <div>
            <Label>Debug</Label>
            <p className="text-caption text-muted-foreground mt-1">
              Diagnostic overlays for troubleshooting message rendering.
            </p>
          </div>
          <FilterRow
            label="Show message kind label on cards"
            description="Render the raw SDK message type (e.g. result · success, assistant) on the bottom-left of each card. Useful when a card looks mis-classified."
            checked={config.debug.showCardKindLabel}
            onChange={(v) => setDebugOption("showCardKindLabel", v)}
          />
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 pt-4 border-t border-border">
          <Button type="button" variant="outline" size="sm" onClick={exportConfig}>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export JSON
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={importConfig}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => importInputRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Import JSON
          </Button>
          <div className="ml-auto" />
          <Button type="button" variant="outline" size="sm" onClick={saveAsUserDefault}>
            <Save className="h-3.5 w-3.5 mr-1.5" />
            Save as my default
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={resetToUserDefault}
            disabled={!hasUserDefault}
            title={hasUserDefault ? "Reset to your saved default" : "No personal default saved yet"}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Reset to my default
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={resetAll}
            className="text-muted-foreground hover:text-destructive"
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Reset to factory
          </Button>
        </div>
      </Card>

      {/* Palette — kept at the bottom because retinting the palette is a
          rare bulk operation that's easier to find when looking for it
          than it is to scroll past every time. */}
      <Card className="p-6">
        <PaletteEditor palette={config.palette} onChange={updatePalette} />
      </Card>

      <p className="text-caption text-muted-foreground text-center">
        Changes save automatically.
      </p>
    </div>
  );
};
