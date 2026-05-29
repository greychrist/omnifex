import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RotateCcw, Upload, Save, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  createDefaultConfig,
  parseConfig,
  serializeConfig,
  pruneRedundantOverrides,
  resolveKind,
  originOf,
  DEFAULT_CATEGORIES,
  type Category,
  type MessageRenderingConfig,
  type KindStyle,
  type CategoryStyle,
  type Palette,
  type PaletteEntry,
  type PaletteName,
  type Terminal,
  type Typography,
} from "@/lib/messageRenderingConfig";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { MessageKindTree, type TreeSelection } from "./appearance/MessageKindTree";
import { KindEditor } from "./appearance/KindEditor";
import { SamplePreview } from "./appearance/SamplePreview";
import { TurnPreview } from "./appearance/TurnPreview";
import {
  SAMPLE_TIMESTAMP,
  debugLabelForKindId,
  previewTextForCategory,
  previewTextForKindId,
} from "./appearance/fixtures";
import { PaletteEditor } from "./appearance/PaletteEditor";
import { TypographyEditor } from "./appearance/TypographyEditor";
import { TerminalEditor } from "./appearance/TerminalEditor";
import type { SettingsPanelProps } from "./types";
import { cn } from "@/lib/utils";
import { fireAndLog } from "@/lib/fireAndLog";

const USER_DEFAULT_KEY = "message_rendering_config_user_default";

type AppearanceSettingsProps = Pick<SettingsPanelProps, "setToast">;

const FIRST_SELECTION: TreeSelection = { type: "category", id: "user" };

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
  const [selected, setSelected] = useState<TreeSelection>(FIRST_SELECTION);
  const [previewMode, setPreviewMode] = useState<"compact" | "verbose">(config.defaultViewMode);
  const [hasUserDefault, setHasUserDefault] = useState(false);
  // Surface every section behind tabs instead of a single long scroll.
  // Persisted across remounts via sessionStorage so a quick trip back to
  // the page doesn't snap the user back to "kinds" — but cleared on app
  // restart so cold-launches always land on the most common surface first.
  const [activeTab, setActiveTab] = useState<string>(() => {
    try {
      return sessionStorage.getItem('omnifex:appearance-tab') ?? 'kinds';
    } catch { return 'kinds'; }
  });
  useEffect(() => {
    try { sessionStorage.setItem('omnifex:appearance-tab', activeTab); }
    catch { /* private mode / quota — non-fatal */ }
  }, [activeTab]);
  const importInputRef = useRef<HTMLInputElement>(null);
  const saveToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load user-default presence on mount so the "Reset to my default" button
  // only enables once the user has actually saved a personal default.
  useEffect(() => {
    api
      .getSetting(USER_DEFAULT_KEY)
      .then((raw) => { setHasUserDefault(!!raw); })
      .catch(() => { setHasUserDefault(false); });
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

  // Every commit prunes overrides whose fields all equal their category
  // (prune-on-save), keeping the persisted override map sparse. The override
  // the user is actively editing is exempt so a just-added (still-inheriting)
  // override isn't pruned out from under them before they diverge a field.
  const mutate = useCallback(
    (producer: (prev: MessageRenderingConfig) => MessageRenderingConfig) => {
      const exempt = new Set<string>(selected.type === "override" ? [selected.id] : []);
      commitConfig(pruneRedundantOverrides(producer(config), exempt));
      scheduleSavedToast();
    },
    [config, commitConfig, scheduleSavedToast, selected],
  );

  const setTypography = useCallback(
    (next: Typography) => {
      mutate((prev) => ({ ...prev, typography: next }));
    },
    [mutate],
  );

  const setTerminal = useCallback(
    (next: Terminal) => {
      mutate((prev) => ({ ...prev, terminal: next }));
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

  // ── Category editing ──────────────────────────────────────────────────
  // Categories carry a full style; an edit writes the field straight onto
  // config.categories[c].
  const updateCategory = useCallback(
    (c: Category, patch: Partial<KindStyle>) => {
      mutate((prev) => ({
        ...prev,
        categories: {
          ...prev.categories,
          [c]: { ...prev.categories[c], ...patch } as CategoryStyle,
        },
      }));
    },
    [mutate],
  );

  const resetCategory = useCallback(
    (c: Category) => {
      mutate((prev) => ({
        ...prev,
        categories: {
          ...prev.categories,
          [c]: structuredClone(DEFAULT_CATEGORIES[c]),
        },
      }));
      setToast({ message: `Reset "${DEFAULT_CATEGORIES[c].label}" category to default`, type: "success" });
    },
    [mutate, setToast],
  );

  // ── Override editing ──────────────────────────────────────────────────
  // Overrides are sparse partial styles. Setting a field persists just that
  // field; clearing a field removes it (reverting to the category default).
  const setOverrideField = useCallback(
    (id: string, patch: Partial<KindStyle>) => {
      mutate((prev) => {
        const nextOverride: Partial<KindStyle> & { label?: string } = {
          ...(prev.overrides[id] ?? {}),
          ...patch,
        };
        return { ...prev, overrides: { ...prev.overrides, [id]: nextOverride } };
      });
    },
    [mutate],
  );

  const clearOverrideField = useCallback(
    (id: string, field: keyof KindStyle) => {
      mutate((prev) => {
        const nextOverride: Partial<KindStyle> & { label?: string } = {
          ...(prev.overrides[id] ?? {}),
        };
        delete nextOverride[field];
        return { ...prev, overrides: { ...prev.overrides, [id]: nextOverride } };
      });
    },
    [mutate],
  );

  const addOverride = useCallback(
    (id: string) => {
      // Select first so the new (empty) override is exempt from prune-on-save.
      setSelected({ type: "override", id });
      const exempt = new Set<string>([id]);
      commitConfig(
        pruneRedundantOverrides(
          { ...config, overrides: { ...config.overrides, [id]: config.overrides[id] ?? {} } },
          exempt,
        ),
      );
      scheduleSavedToast();
    },
    [config, commitConfig, scheduleSavedToast],
  );

  const removeOverride = useCallback(
    (id: string) => {
      const label = config.overrides[id]?.label ?? id;
      // If we're removing the selected override, drop the selection back to
      // its category so the editor doesn't dangle on a missing id.
      if (selected.type === "override" && selected.id === id) {
        setSelected({ type: "category", id: originOf(id) });
      }
      mutate((prev) => {
        const overrides = { ...prev.overrides };
        delete overrides[id];
        return { ...prev, overrides };
      });
      setToast({ message: `Removed "${label}" override`, type: "success" });
    },
    [mutate, setToast, config.overrides, selected],
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
    [commitConfig, setToast],
  );

  const hardFiltersChecked = useMemo(
    () => ({
      hidePartialStreaming: config.hardFilters.hidePartialStreaming,
      hideSubagentLifecycle: config.hardFilters.hideSubagentLifecycle,
      hideHookLifecycle: config.hardFilters.hideHookLifecycle,
      hideRateLimitNotices: config.hardFilters.hideRateLimitNotices,
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

  // Resolve the current selection into the editor + preview inputs.
  const editor = useMemo(() => {
    if (selected.type === "category") {
      const c = selected.id;
      const style = config.categories[c];
      return {
        mode: "category" as const,
        kindId: c,
        label: style.label,
        description: style.description,
        style: style as KindStyle,
        previewKindId: undefined as string | undefined,
        previewText: previewTextForCategory(c),
        debugLabel: undefined as string | undefined,
        onChange: (patch: Partial<KindStyle>) => { updateCategory(c, patch); },
        onClearField: undefined,
        onReset: () => { resetCategory(c); },
        inheritedCategoryLabel: undefined as string | undefined,
        override: undefined as Partial<KindStyle> | undefined,
      };
    }
    const id = selected.id;
    const cat = originOf(id);
    const resolved = resolveKind(config, id);
    const override = config.overrides[id] ?? {};
    return {
      mode: "override" as const,
      kindId: id,
      label: override.label ?? id,
      description: `Inherits the ${config.categories[cat].label} category.`,
      style: resolved,
      previewKindId: id,
      previewText: previewTextForKindId(id),
      debugLabel: debugLabelForKindId(id),
      onChange: (patch: Partial<KindStyle>) => { setOverrideField(id, patch); },
      onClearField: (field: keyof KindStyle) => { clearOverrideField(id, field); },
      onReset: () => { removeOverride(id); },
      inheritedCategoryLabel: config.categories[cat].label,
      override,
    };
  }, [selected, config, updateCategory, resetCategory, setOverrideField, clearOverrideField, removeOverride]);

  return (
    <div className="space-y-4">
      <Tabs value={activeTab} onValueChange={setActiveTab} variant="line" className="w-full">
        <TabsList>
          <TabsTrigger value="kinds">Message kinds</TabsTrigger>
          <TabsTrigger value="turns">Turn preview</TabsTrigger>
          <TabsTrigger value="typography">Typography</TabsTrigger>
          <TabsTrigger value="terminal">Terminal</TabsTrigger>
          <TabsTrigger value="global">Global</TabsTrigger>
          <TabsTrigger value="palette">Palette</TabsTrigger>
        </TabsList>

        <TabsContent value="kinds" className="mt-4">
          <Card className="p-6">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h3 className="text-heading-4">Message kinds</h3>
                <p className="text-caption text-muted-foreground mt-1">
                  Edit a <strong>category</strong> to restyle every kind that belongs to it,
                  or add an <strong>override</strong> to special-case a single kind. Overrides
                  inherit any field you leave unset from their category.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] gap-6">
              <div className="lg:border-r lg:pr-4 lg:border-border lg:max-h-[70vh] lg:overflow-y-auto">
                <MessageKindTree
                  config={config}
                  selected={selected}
                  onSelect={setSelected}
                  onAddOverride={addOverride}
                  onRemoveOverride={removeOverride}
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
                    <SamplePreview
                      style={editor.style}
                      kindId={editor.previewKindId}
                      text={editor.previewText}
                      debugLabel={editor.debugLabel}
                      palette={config.palette}
                      timestamp={SAMPLE_TIMESTAMP}
                    />
                  </div>
                </div>

                <KindEditor
                  mode={editor.mode}
                  kindId={editor.kindId}
                  label={editor.label}
                  description={editor.description}
                  style={editor.style}
                  override={editor.override}
                  inheritedCategoryLabel={editor.inheritedCategoryLabel}
                  palette={config.palette}
                  typography={config.typography}
                  onChange={editor.onChange}
                  onClearField={editor.onClearField}
                  onReset={editor.onReset}
                />
              </div>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="turns" className="mt-4">
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
                    onClick={() => { setPreviewMode(m); }}
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
        </TabsContent>

        <TabsContent value="typography" className="mt-4">
          <Card className="p-6">
            <TypographyEditor typography={config.typography} onChange={setTypography} />
          </Card>
        </TabsContent>

        <TabsContent value="terminal" className="mt-4">
          <Card className="p-6">
            <TerminalEditor terminal={config.terminal} onChange={setTerminal} />
          </Card>
        </TabsContent>

        <TabsContent value="global" className="mt-4">
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
                    onClick={() => { setDefaultViewMode(m); }}
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

            {/* Live-stream overlay filters */}
            <div className="space-y-3 pt-4 border-t border-border">
              <div>
                <Label>Live overlay filters <span className="text-muted-foreground text-xs">(Chat mode only)</span></Label>
                <p className="text-caption text-muted-foreground mt-1">
                  Apply to live-only event streams from the Claude CLI. No effect in Terminal mode.
                </p>
              </div>
              <FilterRow
                label="Hide partial token streaming"
                description="stream_event — typewriter effect during assistant responses."
                checked={hardFiltersChecked.hidePartialStreaming}
                onChange={(v) => { setHardFilter("hidePartialStreaming", v); }}
              />
              <FilterRow
                label="Hide subagent lifecycle"
                description="task_started / task_progress / task_updated — drives SubagentBar."
                checked={hardFiltersChecked.hideSubagentLifecycle}
                onChange={(v) => { setHardFilter("hideSubagentLifecycle", v); }}
              />
              <FilterRow
                label="Hide hook lifecycle"
                description="hook_started / hook_progress / hook_response — drives hook progress UI."
                checked={hardFiltersChecked.hideHookLifecycle}
                onChange={(v) => { setHardFilter("hideHookLifecycle", v); }}
              />
              <FilterRow
                label="Hide rate-limit notices"
                description="rate_limit_event — drives budget telemetry."
                checked={hardFiltersChecked.hideRateLimitNotices}
                onChange={(v) => { setHardFilter("hideRateLimitNotices", v); }}
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
                description="Render the raw message type (e.g. result · success, assistant) on the bottom-left of each card. Useful when a card looks mis-classified."
                checked={config.debug.showCardKindLabel}
                onChange={(v) => { setDebugOption("showCardKindLabel", v); }}
              />
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="palette" className="mt-4">
          <Card className="p-6">
            <PaletteEditor palette={config.palette} onChange={updatePalette} />
          </Card>
        </TabsContent>
      </Tabs>

      {/* Actions live below the tabs so import / export / save-default /
          reset-to-factory are always one click away regardless of which
          tab is open. */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={exportConfig}>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export JSON
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={fireAndLog('appearance-settings:change', importConfig)}
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
          <Button type="button" variant="outline" size="sm" onClick={fireAndLog('appearance-settings:click', saveAsUserDefault)}>
            <Save className="h-3.5 w-3.5 mr-1.5" />
            Save as my default
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={fireAndLog('appearance-settings:click', resetToUserDefault)}
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

      <p className="text-caption text-muted-foreground text-center">
        Changes save automatically.
      </p>
    </div>
  );
};
