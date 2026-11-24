import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RotateCcw, Upload, Save, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  createDefaultConfig,
  parseConfig,
  serializeConfig,
  resolveKind,
  categoryOf,
  KIND_REGISTRY,
  DEFAULT_CATEGORIES,
  type Category,
  type MessageRenderingConfig,
  type KindStyle,
  type ModernStyle,
  type Typography,
} from "@/lib/messageRenderingConfig";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { MessageKindTree, type TreeSelection } from "./appearance/MessageKindTree";
import { KindEditor } from "./appearance/KindEditor";
import { TextEditor } from "./appearance/TextEditor";
import { StepEditor } from "./appearance/StepEditor";
import { MODERN_ITEM_KINDS } from "@/lib/renderingConfigMigration";
import { ModernEditor } from "./appearance/ModernEditor";
import { CardShapeEditor } from "./appearance/CardShapeEditor";
import { ModernTurnPreview } from "./appearance/ModernTurnPreview";
import type { SettingsPanelProps } from "./types";
import { useSaveStatus } from "./saveStatus";
import { fireAndLog } from "@/lib/fireAndLog";

const USER_DEFAULT_KEY = "message_rendering_config_user_default";

// The global commit re-renders every message in every chat and writes to disk; debounced, or a color-input drag lags.
const COMMIT_DEBOUNCE_MS = 150;

type AppearanceSettingsProps = Pick<SettingsPanelProps, "setToast">;

const FIRST_SELECTION: TreeSelection = { type: "category", id: "user" };

const APPEARANCE_TABS: readonly string[] = ["messages", "turns"];
const LEGACY_TABS: Readonly<Record<string, string>> = { kinds: "messages", modern: "messages", typography: "messages" };


export const AppearanceSettings: React.FC<AppearanceSettingsProps> = ({ setToast }) => {
  const { config: committedConfig, setConfig: commitConfig } = useMessageRenderingConfig();
  const { track } = useSaveStatus();

  const [draft, setDraft] = useState<MessageRenderingConfig>(committedConfig);
  const config = draft;
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tells our own debounced commit (skip) from an external change (load, import, reset), which must replace the draft.
  const lastCommittedRef = useRef<MessageRenderingConfig | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const pushToGlobal = useCallback(
    (next: MessageRenderingConfig) => {
      lastCommittedRef.current = next;
      void track(commitConfig(next));
    },
    [commitConfig, track],
  );

  const scheduleCommit = useCallback(() => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      pushToGlobal(draftRef.current);
    }, COMMIT_DEBOUNCE_MS);
  }, [pushToGlobal]);

  const replaceConfig = useCallback(
    (next: MessageRenderingConfig) => {
      if (commitTimerRef.current) {
        clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
      }
      setDraft(next);
      pushToGlobal(next);
    },
    [pushToGlobal],
  );

  useEffect(() => {
    if (committedConfig === lastCommittedRef.current) return;
    setDraft(committedConfig);
  }, [committedConfig]);

  // Flush on unmount, or a fast edit-then-leave is lost.
  useEffect(() => {
    return () => {
      if (commitTimerRef.current) {
        clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
        pushToGlobal(draftRef.current);
      }
    };
  }, [pushToGlobal]);

  const [selected, setSelected] = useState<TreeSelection>(FIRST_SELECTION);
  const [hasUserDefault, setHasUserDefault] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(() => {
    try {
      const raw = sessionStorage.getItem('omnifex:appearance-tab');
      const saved = raw ? (LEGACY_TABS[raw] ?? raw) : null;
      return saved && APPEARANCE_TABS.includes(saved) ? saved : 'messages';
    } catch { return 'messages'; }
  });
  useEffect(() => {
    try { sessionStorage.setItem('omnifex:appearance-tab', activeTab); }
    catch { /* private mode / quota — non-fatal */ }
  }, [activeTab]);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .getSetting(USER_DEFAULT_KEY)
      .then((raw) => { setHasUserDefault(!!raw); })
      .catch(() => { setHasUserDefault(false); });
  }, []);

  const mutate = useCallback(
    (producer: (prev: MessageRenderingConfig) => MessageRenderingConfig) => {
      setDraft((prev) => producer(prev));
      scheduleCommit();
    },
    [scheduleCommit],
  );

  const setTypography = useCallback(
    (next: Typography) => {
      mutate((prev) => ({ ...prev, typography: next }));
    },
    [mutate],
  );

  const setModern = useCallback(
    (next: ModernStyle) => {
      mutate((prev) => ({ ...prev, modern: next }));
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
      replaceConfig(parseConfig(raw));
      setToast({ message: "Restored your saved default", type: "success" });
    } catch {
      setToast({ message: "Failed to restore default", type: "error" });
    }
  }, [replaceConfig, setToast]);

  const updateCategory = useCallback(
    (c: Category, patch: Partial<KindStyle>) => {
      mutate((prev) => ({
        ...prev,
        categories: {
          ...prev.categories,
          [c]: { ...prev.categories[c], ...patch },
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

  // Kinds carry a sparse patch: write only the changed field; unset fields inherit.
  const updateKind = useCallback(
    (id: string, patch: Partial<KindStyle>) => {
      mutate((prev) => ({ ...prev, kinds: { ...prev.kinds, [id]: { ...(prev.kinds[id] ?? {}), ...patch } } }));
    },
    [mutate],
  );

  const clearKindField = useCallback(
    (id: string, field: keyof KindStyle) => {
      mutate((prev) => {
        const { [field]: _cleared, ...next } = prev.kinds[id] ?? {};
        const { [id]: _previous, ...kinds } = prev.kinds;
        return { ...prev, kinds: Object.keys(next).length === 0 ? kinds : { ...kinds, [id]: next } };
      });
    },
    [mutate],
  );

  const resetKind = useCallback(
    (id: string) => {
      mutate((prev) => {
        const { [id]: _reset, ...kinds } = prev.kinds;
        return { ...prev, kinds };
      });
      setToast({ message: `Reset "${KIND_REGISTRY[id]?.label ?? id}" to default`, type: "success" });
    },
    [mutate, setToast],
  );

  const setCardBorderOpacity = useCallback(
    (pct: number) => { mutate((prev) => ({ ...prev, cardBorderOpacity: pct })); },
    [mutate],
  );

  const setCardBorderRadius = useCallback(
    (px: number) => { mutate((prev) => ({ ...prev, cardBorderRadius: px })); },
    [mutate],
  );

  const resetAll = useCallback(() => {
    if (!window.confirm("Reset all appearance settings to defaults? This cannot be undone.")) {
      return;
    }
    replaceConfig(createDefaultConfig());
    setToast({ message: "Appearance settings reset to defaults", type: "success" });
  }, [replaceConfig, setToast]);

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
        replaceConfig(imported);
        setToast({ message: `Imported ${file.name}`, type: "success" });
      } catch {
        setToast({ message: "Failed to import config", type: "error" });
      }
    },
    [replaceConfig, setToast],
  );

  const editor = useMemo(() => {
    const categoryEditor = (c: Category) => {
      const style = config.categories[c];
      return {
        mode: "category" as const,
        label: style.label,
        description: style.description,
        style: style as KindStyle,
        onChange: (patch: Partial<KindStyle>) => { updateCategory(c, patch); },
        onClearField: (field: keyof KindStyle) => {
          updateCategory(c, { [field]: DEFAULT_CATEGORIES[c][field] });
        },
        onReset: () => { resetCategory(c); },
        inheritedCategoryLabel: undefined as string | undefined,
        builtIn: undefined as Partial<KindStyle> | undefined,
        override: undefined as Partial<KindStyle> | undefined,
        offersStandard: true,
        offersColor: true,
      };
    };

    if (selected.type === "kind") {
      const id = selected.id;
      const def = KIND_REGISTRY[id];
      const cat = categoryOf(id);
      return {
        mode: "kind" as const,
        label: def?.label ?? id,
        description: def?.description ?? `Inherits the ${config.categories[cat].label} category.`,
        style: resolveKind(config, id),
        onChange: (patch: Partial<KindStyle>) => { updateKind(id, patch); },
        onClearField: (field: keyof KindStyle) => { clearKindField(id, field); },
        onReset: () => { resetKind(id); },
        inheritedCategoryLabel: config.categories[cat].label,
        builtIn: def?.default,
        override: config.kinds[id],
        offersStandard: !MODERN_ITEM_KINDS.has(id),
        offersColor: id !== "user.prompt",
      };
    }

    return categoryEditor(selected.type === "category" ? selected.id : "user");
  }, [selected, config, updateCategory, resetCategory, updateKind, clearKindField, resetKind]);

  return (
    <div className="space-y-4">
      <Tabs value={activeTab} onValueChange={setActiveTab} variant="line" className="w-full">
        <TabsList>
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="turns">Turn preview</TabsTrigger>
        </TabsList>

        <TabsContent value="messages" className="mt-4 space-y-4">
          <Card className="p-6">
            <ModernEditor config={config} onChange={setModern} />
          </Card>

          <Card className="p-6">
            <CardShapeEditor
              cardBorderOpacity={config.cardBorderOpacity}
              cardBorderRadius={config.cardBorderRadius}
              onCardBorderOpacity={setCardBorderOpacity}
              onCardBorderRadius={setCardBorderRadius}
            />
          </Card>

          <Card className="p-6">
            <div className="mb-4">
              <h3 className="text-heading-4">Steps, messages and text</h3>
              <p className="text-caption text-muted-foreground mt-1">
                Everything the chat draws: the steps of the work timeline, the records drawn
                as a line — their icon, color, and whether Standard shows them; set a{" "}
                <strong>category</strong> for every kind in it, or a <strong>kind</strong> to
                override it — and the text. Expanded shows every record.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] gap-6">
              <div className="lg:border-r lg:pr-4 lg:border-border lg:max-h-[70vh] lg:overflow-y-auto">
                <MessageKindTree config={config} selected={selected} onSelect={setSelected} />
              </div>
              <div className="min-w-0">
                {selected.type === "step" ? (
                  <StepEditor
                    kind={selected.id}
                    icon={config.modern.stepIcons[selected.id]}
                    color={config.modern.stepColors[selected.id]}
                    onIcon={(icon) => { setModern({ ...config.modern, stepIcons: { ...config.modern.stepIcons, [selected.id]: icon } }); }}
                    onColor={(color) => { setModern({ ...config.modern, stepColors: { ...config.modern.stepColors, [selected.id]: color } }); }}
                  />
                ) : selected.type === "text" ? (
                  <TextEditor
                    typography={config.typography}
                    onTypography={setTypography}
                    modern={config.modern}
                    onModern={setModern}
                  />
                ) : (
                <KindEditor
                  mode={editor.mode}
                  label={editor.label}
                  description={editor.description}
                  style={editor.style}
                  override={editor.override}
                  inheritedCategoryLabel={editor.inheritedCategoryLabel}
                  builtIn={editor.builtIn}
                  onChange={editor.onChange}
                  onClearField={editor.onClearField}
                  onReset={editor.onReset}
                  offersStandard={editor.offersStandard}
                  offersColor={editor.offersColor}
                />
                )}
              </div>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="turns" className="mt-4">
          <Card className="p-6">
            <ModernTurnPreview config={config} />
          </Card>
        </TabsContent>

      </Tabs>

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
