import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover } from "@/components/ui/popover";
import { api, type Account, type PathRule, type SessionDefaults } from "@/lib/api";
import { AccountBadge } from "@/components/AccountBadge";
import { useAccounts } from "@/contexts/AccountsContext";
import { Trash2, Plus, Pencil, FolderOpen, Check, ChevronDown } from "lucide-react";
import { IconPicker, ICON_MAP } from "./IconPicker";
import { MODELS } from "./ModelPicker";
import { THINKING_CONFIGS, PERMISSION_MODES, EFFORT_LEVELS } from "./ControlBar";
import { ColorSwatchGrid } from "@/components/ui/ColorSwatchGrid";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { fireAndLog } from "@/lib/fireAndLog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

const ACCOUNT_TYPES = [
  { value: "max", label: "Max", desc: "No cost, usage limits only" },
  { value: "enterprise", label: "Enterprise", desc: "Has cost" },
  { value: "pro", label: "Pro", desc: "Has cost" },
  { value: "free", label: "Free", desc: "Has cost" },
];

async function pickFolder(defaultPath?: string): Promise<string | null> {
  try {
    const paths = await window.electronAPI.showOpenDialog({
      properties: ['openDirectory'],
      title: "Select Folder",
      defaultPath: defaultPath || (await api.getHomeDirectory()),
    }) as string[] | null;
    return paths?.[0] ?? null;
  } catch {
    return null;
  }
}

interface DirInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** When true, render at the same compact size as the session-defaults
   *  pickers (h-7 text-xs). Default is the larger h-8 text-sm used in
   *  the add-rule form etc. */
  compact?: boolean;
}

const DirInput: React.FC<DirInputProps> = ({ value, onChange, placeholder, compact }) => {
  const h = compact ? "h-7" : "h-8";
  const ts = compact ? "text-xs" : "text-sm";
  return (
    <div className="flex gap-1">
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); }}
        className={cn(h, ts, "flex-1")}
      />
      <Button
        variant="outline"
        size="sm"
        className={cn(h, "px-2")}
        onClick={fireAndLog('account-settings:click', async () => {
          const folder = await pickFolder(value || undefined);
          if (folder) onChange(folder);
        })}
        title="Browse..."
      >
        <FolderOpen className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
};

const TypeSelect: React.FC<{ value: string; onChange: (v: string) => void; compact?: boolean }> = ({
  value,
  onChange,
  compact,
}) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger className={cn("w-full", compact ? "h-7 text-xs" : "h-8 text-sm")}>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {ACCOUNT_TYPES.map((t) => (
        <SelectItem key={t.value} value={t.value}>
          {t.label} ({t.desc})
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

/**
 * Per-call cost estimate shown under the summary-model dropdown. The
 * range reflects the spread between short (~5K tok in) and long (~50K
 * tok in) sessions. Output is ~80 tokens regardless — negligible.
 * Pricing: Haiku 4.5 $1/$5, Sonnet 4.6 $3/$15, Opus 4.7 $15/$75 per MTok.
 */
function summaryCostEstimate(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return '~$0.005–$0.05 per session.';
  if (m.includes('sonnet')) return '~$0.015–$0.15 per session.';
  if (m.includes('opus')) return '~$0.075–$0.75 per session.';
  return 'Cost depends on the chosen model.';
}

// ── Session-defaults pickers ────────────────────────────────────────────
//
// Visual style mirrors NewSessionForm (the form on the project-open
// screen): outlined trigger button per field, full-width within its grid
// column, small uppercase label above. Every dropdown has an "App
// default" entry that maps to `undefined` in the stored value — that's
// how we say "fall through to the global app default for this field"
// rather than pinning a specific value.

function DropdownTrigger({
  open,
  onClick,
  title,
  children,
}: {
  open: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="w-full justify-between h-9 px-2 font-normal gap-1"
      aria-expanded={open}
      title={title}
    >
      <span className="flex items-center gap-1 min-w-0 overflow-hidden">{children}</span>
      <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
    </Button>
  );
}

function DropdownRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 rounded-md text-left transition-colors",
        "hover:bg-accent",
        selected && "bg-accent",
      )}
    >
      {children}
    </button>
  );
}

const APP_DEFAULT_LABEL = "App default";

const SessionDefaultsEditor: React.FC<{
  value: SessionDefaults;
  onChange: (v: SessionDefaults) => void;
}> = ({ value, onChange }) => {
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [permsOpen, setPermsOpen] = useState(false);

  const selectedModel = value.model ? MODELS.find((m) => m.id === value.model) : null;
  const selectedEffort = value.effort ? EFFORT_LEVELS.find((e) => e.id === value.effort) : null;
  const selectedThinking = value.thinkingConfig
    ? THINKING_CONFIGS.find((c) => c.id === value.thinkingConfig)
    : null;
  const selectedPerm = value.permissionMode
    ? PERMISSION_MODES.find((m) => m.id === value.permissionMode)
    : null;

  return (
    <div className="space-y-2 pt-5">
      <h4 className="text-sm font-medium">Session Defaults</h4>
      <div className="grid grid-cols-4 gap-2">
        {/* Model */}
        <div className="flex flex-col gap-1 min-w-0">
          <Label className="text-[10px] uppercase tracking-wider text-foreground/50">Model</Label>
          <Popover
            open={modelOpen}
            onOpenChange={setModelOpen}
            align="start"
            side="bottom"
            trigger={
              <DropdownTrigger
                open={modelOpen}
                onClick={() => { setModelOpen(!modelOpen); }}
                title={selectedModel?.name ?? APP_DEFAULT_LABEL}
              >
                <span
                  className={cn(
                    "text-[11px] truncate",
                    selectedModel ? "" : "text-muted-foreground italic",
                  )}
                >
                  {selectedModel?.name ?? APP_DEFAULT_LABEL}
                </span>
              </DropdownTrigger>
            }
            content={
              <div className="w-[260px] p-1">
                <DropdownRow
                  selected={!selectedModel}
                  onClick={() => {
                    onChange({ ...value, model: undefined });
                    setModelOpen(false);
                  }}
                >
                  <span className="text-xs italic text-muted-foreground">{APP_DEFAULT_LABEL}</span>
                </DropdownRow>
                {MODELS.map((model) => (
                  <DropdownRow
                    key={model.id}
                    selected={selectedModel?.id === model.id}
                    onClick={() => {
                      onChange({ ...value, model: model.id });
                      setModelOpen(false);
                    }}
                  >
                    <span className="text-xs">{model.name}</span>
                  </DropdownRow>
                ))}
              </div>
            }
          />
        </div>

        {/* Effort */}
        <div className="flex flex-col gap-1 min-w-0">
          <Label className="text-[10px] uppercase tracking-wider text-foreground/50">Effort</Label>
          <Popover
            open={effortOpen}
            onOpenChange={setEffortOpen}
            align="start"
            side="bottom"
            trigger={
              <DropdownTrigger
                open={effortOpen}
                onClick={() => { setEffortOpen(!effortOpen); }}
                title={selectedEffort?.description ?? APP_DEFAULT_LABEL}
              >
                {selectedEffort ? (
                  <>
                    <span className={cn("text-[11px] font-bold shrink-0", selectedEffort.color)}>
                      {selectedEffort.shortName}
                    </span>
                    <span className="text-[10px] leading-tight truncate">{selectedEffort.name}</span>
                  </>
                ) : (
                  <span className="text-[11px] truncate text-muted-foreground italic">
                    {APP_DEFAULT_LABEL}
                  </span>
                )}
              </DropdownTrigger>
            }
            content={
              <div className="w-[240px] p-1">
                <DropdownRow
                  selected={!selectedEffort}
                  onClick={() => {
                    onChange({ ...value, effort: undefined });
                    setEffortOpen(false);
                  }}
                >
                  <span className="text-xs italic text-muted-foreground">{APP_DEFAULT_LABEL}</span>
                </DropdownRow>
                {EFFORT_LEVELS.map((level) => (
                  <DropdownRow
                    key={level.id}
                    selected={selectedEffort?.id === level.id}
                    onClick={() => {
                      onChange({ ...value, effort: level.id });
                      setEffortOpen(false);
                    }}
                  >
                    <span className={cn("text-xs font-bold w-10 shrink-0", level.color)}>
                      {level.shortName}
                    </span>
                    <span className="text-[10px] leading-tight">{level.name}</span>
                  </DropdownRow>
                ))}
              </div>
            }
          />
        </div>

        {/* Thinking */}
        <div className="flex flex-col gap-1 min-w-0">
          <Label className="text-[10px] uppercase tracking-wider text-foreground/50">Thinking</Label>
          <Popover
            open={thinkingOpen}
            onOpenChange={setThinkingOpen}
            align="start"
            side="bottom"
            trigger={
              <DropdownTrigger
                open={thinkingOpen}
                onClick={() => { setThinkingOpen(!thinkingOpen); }}
                title={selectedThinking?.description ?? APP_DEFAULT_LABEL}
              >
                {selectedThinking ? (
                  <>
                    <span className={cn("text-[11px] font-bold shrink-0", selectedThinking.color)}>
                      {selectedThinking.shortName}
                    </span>
                    <span className="text-[10px] leading-tight truncate">{selectedThinking.name}</span>
                  </>
                ) : (
                  <span className="text-[11px] truncate text-muted-foreground italic">
                    {APP_DEFAULT_LABEL}
                  </span>
                )}
              </DropdownTrigger>
            }
            content={
              <div className="w-[240px] p-1">
                <DropdownRow
                  selected={!selectedThinking}
                  onClick={() => {
                    onChange({ ...value, thinkingConfig: undefined });
                    setThinkingOpen(false);
                  }}
                >
                  <span className="text-xs italic text-muted-foreground">{APP_DEFAULT_LABEL}</span>
                </DropdownRow>
                {THINKING_CONFIGS.map((cfg) => (
                  <DropdownRow
                    key={cfg.id}
                    selected={selectedThinking?.id === cfg.id}
                    onClick={() => {
                      onChange({ ...value, thinkingConfig: cfg.id });
                      setThinkingOpen(false);
                    }}
                  >
                    <span className={cn("text-xs font-bold w-10 shrink-0", cfg.color)}>
                      {cfg.shortName}
                    </span>
                    <span className="text-[10px] leading-tight">{cfg.name}</span>
                  </DropdownRow>
                ))}
              </div>
            }
          />
        </div>

        {/* Permissions */}
        <div className="flex flex-col gap-1 min-w-0">
          <Label className="text-[10px] uppercase tracking-wider text-foreground/50">Permissions</Label>
          <Popover
            open={permsOpen}
            onOpenChange={setPermsOpen}
            align="start"
            side="bottom"
            trigger={
              <DropdownTrigger
                open={permsOpen}
                onClick={() => { setPermsOpen(!permsOpen); }}
                title={selectedPerm?.description ?? APP_DEFAULT_LABEL}
              >
                {selectedPerm ? (
                  <>
                    <span className={cn("shrink-0", selectedPerm.color)}>{selectedPerm.icon}</span>
                    <span className={cn("text-[11px] truncate", selectedPerm.color)}>
                      {selectedPerm.name}
                    </span>
                  </>
                ) : (
                  <span className="text-[11px] truncate text-muted-foreground italic">
                    {APP_DEFAULT_LABEL}
                  </span>
                )}
              </DropdownTrigger>
            }
            content={
              <div className="w-[260px] p-1">
                <DropdownRow
                  selected={!selectedPerm}
                  onClick={() => {
                    onChange({ ...value, permissionMode: undefined });
                    setPermsOpen(false);
                  }}
                >
                  <span className="text-xs italic text-muted-foreground">{APP_DEFAULT_LABEL}</span>
                </DropdownRow>
                {PERMISSION_MODES.map((mode) => (
                  <DropdownRow
                    key={mode.id}
                    selected={selectedPerm?.id === mode.id}
                    onClick={() => {
                      onChange({ ...value, permissionMode: mode.id });
                      setPermsOpen(false);
                    }}
                  >
                    <span className={cn("shrink-0", mode.color)}>{mode.icon}</span>
                    <span className={cn("text-xs", mode.color)}>{mode.name}</span>
                  </DropdownRow>
                ))}
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
};

export const AccountSettings: React.FC = () => {
  const { refresh: refreshAccountsContext } = useAccounts();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [pathRules, setPathRules] = useState<PathRule[]>([]);
  const [overrides, setOverrides] = useState<{project_path: string; account_id: number; account_name: string}[]>([]);

  // Test resolution state
  const [testPath, setTestPath] = useState("");
  const [testResult, setTestResult] = useState<{
    account: { name: string; account_type: string; config_dir: string; color?: string | null };
    match_type: string;
    match_detail: string;
  } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // Add account form
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDir, setNewDir] = useState("");
  const [newType, setNewType] = useState("pro");
  const [newColor, setNewColor] = useState("#3b82f6");
  const [newIcon, setNewIcon] = useState<string>("user");
  const [newSessionDefaults, setNewSessionDefaults] = useState<SessionDefaults>({});
  const [showNewIconPicker, setShowNewIconPicker] = useState(false);

  // Edit account state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editDir, setEditDir] = useState("");
  const [editType, setEditType] = useState("");
  const [editColor, setEditColor] = useState("#3b82f6");
  const [editIcon, setEditIcon] = useState<string>("user");
  const [editSessionDefaults, setEditSessionDefaults] = useState<SessionDefaults>({});
  const [editCliPath, setEditCliPath] = useState<string>("");
  const [showEditIconPicker, setShowEditIconPicker] = useState(false);
  // Per-account model picker stays — different accounts may want different
  // models for cost/preference. The auto-on-close TOGGLE moved to a single
  // global control in Settings → Session Summaries (replacing the old
  // per-account `summarizeOnClose` flag).
  const [editSummaryModel, setEditSummaryModel] = useState<string | null>('haiku');

  // Add rule form
  const [showAddRule, setShowAddRule] = useState(false);
  const [newRulePrefix, setNewRulePrefix] = useState("");
  const [newRuleAccountId, setNewRuleAccountId] = useState<number | null>(null);

  const loadData = async () => {
    try {
      const [accts, rules] = await Promise.all([
        api.listAccounts(),
        api.listPathRules(),
      ]);
      setAccounts(accts);
      setPathRules(rules);
      refreshAccountsContext();
    } catch (error) {
      console.error("Failed to load account data:", error);
    }
  };

  useEffect(() => {
    loadData();
    api.listProjectOverrides().then(setOverrides).catch(console.error);
  }, []);

  const handleTestResolution = async () => {
    if (!testPath.trim()) return;
    setTestError(null);
    setTestResult(null);
    try {
      const result = await api.explainAccountResolution(testPath.trim());
      if (result) {
        setTestResult(result);
      } else {
        setTestError("No account would be resolved for this path");
      }
    } catch (err) {
      setTestError(String(err));
    }
  };

  const startEdit = (account: Account) => {
    setEditingId(account.id);
    setEditName(account.name);
    setEditDir(account.config_dir);
    setEditType(account.account_type);
    setEditColor(account.color || "#3b82f6");
    setEditIcon(account.icon || "user");
    setEditSessionDefaults(account.session_defaults ?? {});
    setEditCliPath(account.cli_path ?? "");
    setEditSummaryModel(account.summaryModel ?? 'haiku');
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const saveEdit = async () => {
    if (editingId === null || !editName.trim() || !editDir.trim()) return;
    // CLI path UI was retired — preserve whatever value was already on
    // the account rather than wiping it. No validation needed here since
    // the user can no longer change it from this dialog.
    const trimmedCliPath = editCliPath.trim();
    try {
      const defaults = Object.keys(editSessionDefaults).length > 0 ? editSessionDefaults : null;
      const cliPath = trimmedCliPath || null;
      await api.updateAccount(editingId, editName.trim(), editDir.trim(), editType, editColor, editIcon, defaults, cliPath);
      // Persist the per-account summary model via the dedicated channel.
      // The first argument is the legacy per-account `summarizeOnClose`
      // flag — retired in favour of the global toggle in Settings →
      // Session Summaries, but the IPC signature stays stable. Pass
      // `!!editSummaryModel` so the dead column at least tracks "this
      // account has a model picked", which avoids surprises if anything
      // else still reads it.
      await api.accountUpdateSummary(
        editingId,
        !!editSummaryModel,
        editSummaryModel ?? null,
      );
      setEditingId(null);
      await loadData();
    } catch (error) {
      console.error("Failed to update account:", error);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim() || !newDir.trim()) return;
    try {
      const defaults = Object.keys(newSessionDefaults).length > 0 ? newSessionDefaults : undefined;
      // CLI path UI retired — new accounts always start with no override.
      const cliPath: string | null = null;
      // No isDefault parameter — there is no notion of a default account.
      await api.createAccount(newName.trim(), newDir.trim(), newType, newColor, newIcon, defaults, cliPath);
      setNewName("");
      setNewDir("");
      setNewType("pro");
      setNewColor("#3b82f6");
      setNewIcon("user");
      setNewSessionDefaults({});
      setShowAddAccount(false);
      await loadData();
    } catch (error) {
      console.error("Failed to create account:", error);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.deleteAccount(id);
      await loadData();
    } catch (error) {
      console.error("Failed to delete account:", error);
    }
  };

  const handleAddRule = async () => {
    if (!newRulePrefix.trim() || newRuleAccountId === null) return;
    try {
      await api.addPathRule(newRuleAccountId, newRulePrefix.trim());
      setNewRulePrefix("");
      setNewRuleAccountId(null);
      setShowAddRule(false);
      await loadData();
    } catch (error) {
      console.error("Failed to add path rule:", error);
    }
  };

  const handleRemoveRule = async (ruleId: number) => {
    try {
      await api.removePathRule(ruleId);
      await loadData();
    } catch (error) {
      console.error("Failed to remove rule:", error);
    }
  };

  return (
    <div className="space-y-6">
      {/* Accounts */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Accounts</h3>
        <div className="space-y-2">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-muted/30"
            >
              <AccountBadge name={account.name} color={account.color} />
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                {account.account_type}
              </span>
              <span className="text-xs text-muted-foreground flex-1 truncate">
                {account.config_dir}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground"
                onClick={() => { startEdit(account); }}
                title="Edit"
              >
                <Pencil className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={fireAndLog('account-settings:click', () => handleDelete(account.id))}
                title="Delete"
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>

        {/* Edit-account dialog. Mounted once at panel level; opens when
            startEdit() sets editingId. Cancel closes via cancelEdit;
            save closes via saveEdit on success. */}
        <Dialog
          open={editingId !== null}
          onOpenChange={(open) => {
            if (!open) cancelEdit();
          }}
        >
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit account</DialogTitle>
              <DialogDescription>
                Change name, config directory, account type, appearance,
                session defaults, and per-session summarization options.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2">
              {/* Name + Type on a single row to use the dialog width and
                  keep the top of the form compact. */}
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Account name</label>
                  <Input
                    placeholder="Account name"
                    value={editName}
                    onChange={(e) => { setEditName(e.target.value); }}
                    className="h-7 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Account type</label>
                  <TypeSelect value={editType} onChange={setEditType} compact />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Config directory</label>
                <DirInput
                  value={editDir}
                  onChange={setEditDir}
                  placeholder="Config directory"
                  compact
                />
              </div>
              {/* Color (single native picker swatch) + icon button on one
                  row. Labels kept so the controls aren't ambiguous. */}
              <div className="flex items-center gap-3 pt-1">
                <label className="text-xs text-muted-foreground">Color</label>
                <input
                  type="color"
                  value={editColor}
                  onChange={(e) => { setEditColor(e.target.value); }}
                  className="w-7 h-7 rounded cursor-pointer border border-border bg-transparent"
                  title="Pick color"
                  aria-label="Account color"
                />
                <label className="text-xs text-muted-foreground ml-2">Icon</label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => { setShowEditIconPicker(true); }}
                  className="h-7 px-2 shrink-0"
                  title="Pick icon"
                >
                  {(() => {
                    const IconComponent = ICON_MAP[editIcon] || ICON_MAP.user;
                    return IconComponent ? <IconComponent className="w-4 h-4" /> : null;
                  })()}
                  <span className="ml-2 text-xs">{editIcon}</span>
                </Button>
              </div>
              {/* Preview both badge variants the user will see at runtime:
                  the compact icon-only square (tabs) and the full pill with
                  account-type suffix (session header). Pass color/icon/type
                  explicitly so the preview reflects the in-flight edits, not
                  whatever the AccountsContext has cached. */}
              <div className="flex items-center gap-3">
                <label className="text-xs text-muted-foreground w-14">Preview</label>
                <div className="flex items-center gap-2">
                  <AccountBadge
                    name={editName || "Account"}
                    color={editColor}
                    icon={editIcon}
                    variant="compact"
                  />
                  <AccountBadge
                    name={editName || "Account"}
                    color={editColor}
                    icon={editIcon}
                    accountType={editType}
                    variant="full"
                  />
                </div>
              </div>
              <SessionDefaultsEditor value={editSessionDefaults} onChange={setEditSessionDefaults} />
              {/* Session Summaries — model picker only. The auto-on-close
                  toggle moved to Settings → Session Summaries (global,
                  applies to every account). The prompt template also lives
                  there. */}
              <div className="space-y-2 pt-5">
                <h4 className="text-sm font-medium">Session Summaries</h4>
                <div className="flex items-center justify-between gap-3">
                  <label className="text-xs text-muted-foreground">
                    Summary model
                  </label>
                  <Select
                    value={editSummaryModel ?? '__none__'}
                    onValueChange={(v) =>
                      { setEditSummaryModel(v === '__none__' ? null : v); }
                    }
                  >
                    <SelectTrigger className="h-7 w-44 text-xs">
                      <SelectValue placeholder="Pick a model" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">(no model)</SelectItem>
                      {MODELS.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {editSummaryModel
                    ? summaryCostEstimate(editSummaryModel)
                    : 'Pick a model to enable summarization for this account.'}
                  {' '}Costs come out of this account's plan allotment for
                  Pro/Max plans, or are billed per token for API keys. The
                  on/off switch is in Settings → Session Summaries; the
                  prompt template is there too.
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={cancelEdit}>
                Cancel
              </Button>
              <Button onClick={fireAndLog('account-settings:click', saveEdit)}>
                <Check className="mr-2 h-4 w-4" />
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {showAddAccount ? (
          <div className="mt-3 space-y-2 p-3 rounded-lg border border-dashed border-border">
            <Input
              placeholder="Account name (e.g., personal)"
              value={newName}
              onChange={(e) => { setNewName(e.target.value); }}
              className="h-8 text-sm"
            />
            <DirInput
              value={newDir}
              onChange={setNewDir}
              placeholder="Config directory (e.g., ~/.claude-personal)"
            />
            <TypeSelect value={newType} onChange={setNewType} />
            <div className="space-y-2">
              <div className="flex items-start gap-3">
                <label className="text-xs text-muted-foreground w-14 mt-1">Color</label>
                <ColorSwatchGrid value={newColor} onChange={setNewColor} />
              </div>
              <div className="flex items-center gap-3">
                <label className="text-xs text-muted-foreground w-14">Icon</label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => { setShowNewIconPicker(true); }}
                  className="h-8 px-2"
                >
                  {(() => {
                    const IconComponent = ICON_MAP[newIcon] || ICON_MAP.user;
                    return IconComponent ? <IconComponent className="w-4 h-4" /> : null;
                  })()}
                  <span className="ml-2 text-xs">{newIcon}</span>
                </Button>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-xs text-muted-foreground w-14">Preview</label>
                <div className="flex items-center gap-2">
                  <AccountBadge
                    name={newName || "Account"}
                    color={newColor}
                    icon={newIcon}
                    variant="compact"
                  />
                  <span className="text-xs text-foreground">{newName || "Account"}</span>
                </div>
              </div>
            </div>
            <SessionDefaultsEditor value={newSessionDefaults} onChange={setNewSessionDefaults} />
            <div className="flex gap-2">
              <Button size="sm" onClick={fireAndLog('account-settings:click', handleCreate)} className="h-7 text-xs">
                Add
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => { setShowAddAccount(false); }}
                className="h-7 text-xs"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="link"
            size="sm"
            className="mt-2 h-6 px-0 text-xs"
            onClick={() => { setShowAddAccount(true); }}
          >
            <Plus className="w-3 h-3 mr-1" />
            Add account
          </Button>
        )}
      </div>

      {/* Path Rules */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Path Rules</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Projects under these paths are automatically assigned to the matching account.
        </p>
        <div className="space-y-2">
          {pathRules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-muted/30"
            >
              <code className="text-xs flex-1 text-foreground">{rule.path_prefix}</code>
              <span className="text-muted-foreground text-xs">&rarr;</span>
              <AccountBadge name={rule.account_name} color={accounts.find(a => a.id === rule.account_id)?.color} />
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={fireAndLog('account-settings:click', () => handleRemoveRule(rule.id))}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>

        {showAddRule ? (
          <div className="mt-3 space-y-2 p-3 rounded-lg border border-dashed border-border">
            <DirInput
              value={newRulePrefix}
              onChange={setNewRulePrefix}
              placeholder="Path prefix (e.g., ~/Repos/personal/)"
            />
            <Select
              value={newRuleAccountId != null ? String(newRuleAccountId) : undefined}
              onValueChange={(v) => { setNewRuleAccountId(v ? Number(v) : null); }}
            >
              <SelectTrigger className="w-full h-8 text-sm">
                <SelectValue placeholder="Select account..." />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Button size="sm" onClick={fireAndLog('account-settings:add-rule', handleAddRule)} className="h-7 text-xs" disabled={!newRulePrefix.trim() || newRuleAccountId === null}>
                Add
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => { setShowAddRule(false); }}
                className="h-7 text-xs"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="link"
            size="sm"
            className="mt-2 h-6 px-0 text-xs"
            onClick={() => { setShowAddRule(true); }}
          >
            <Plus className="w-3 h-3 mr-1" />
            Add rule
          </Button>
        )}
      </div>

      {/* Project Overrides */}
      <div className="mt-6">
        <h3 className="text-sm font-medium mb-2">Project Overrides</h3>
        <p className="text-xs text-foreground/50 mb-2">
          Projects explicitly assigned to specific accounts.
        </p>
        {overrides.length === 0 ? (
          <p className="text-xs text-foreground/40 italic">No project overrides set.</p>
        ) : (
          <div className="space-y-1">
            {overrides.map((override) => (
              <div key={override.project_path} className="flex items-center justify-between text-sm py-1.5 px-2 rounded hover:bg-foreground/5">
                <span className="font-mono text-xs truncate max-w-[300px]">{override.project_path}</span>
                <AccountBadge name={override.account_name} color={accounts.find(a => a.id === override.account_id)?.color} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Test Account Resolution */}
      <div className="mt-6">
        <h3 className="text-sm font-medium mb-2">Test Account Resolution</h3>
        <p className="text-xs text-foreground/50 mb-2">
          Enter any path to see which account would be used and why.
        </p>
        <div className="flex gap-2">
          <Input
            value={testPath}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setTestPath(e.target.value); }}
            onKeyDown={fireAndLog('account-settings:key-down', async (e: React.KeyboardEvent) => { if (e.key === "Enter") await handleTestResolution(); })}
            placeholder="/Users/you/Repos/project-name"
            className="font-mono text-sm"
          />
          <Button onClick={fireAndLog('account-settings:click', handleTestResolution)} size="sm" variant="outline">
            Test
          </Button>
        </div>
        {testResult && (
          <div className="mt-2 p-3 rounded border border-green-500/30 bg-green-500/5 text-sm">
            <div className="flex items-center gap-2">
              <AccountBadge name={testResult.account.name} color={testResult.account.color} />
              <span className="text-foreground/50">({testResult.account.account_type})</span>
            </div>
            <div className="text-xs text-foreground/50 mt-1">
              Matched by: <strong>{testResult.match_type}</strong> — {testResult.match_detail}
            </div>
            <div className="text-xs font-mono text-foreground/40 mt-1">
              Config: {testResult.account.config_dir}
            </div>
          </div>
        )}
        {testError && (
          <div className="mt-2 p-3 rounded border border-red-500/30 bg-red-500/5 text-sm text-red-400">
            {testError}
          </div>
        )}
      </div>
      <IconPicker
        value={editIcon}
        onSelect={setEditIcon}
        isOpen={showEditIconPicker}
        onClose={() => { setShowEditIconPicker(false); }}
      />
      <IconPicker
        value={newIcon}
        onSelect={setNewIcon}
        isOpen={showNewIconPicker}
        onClose={() => { setShowNewIconPicker(false); }}
      />
    </div>
  );
};
