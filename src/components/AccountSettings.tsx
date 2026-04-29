import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type Account, type PathRule, type SessionDefaults } from "@/lib/api";
import { AccountBadge } from "@/components/AccountBadge";
import { useAccounts } from "@/contexts/AccountsContext";
import { Trash2, Plus, Pencil, FolderOpen, Check, X } from "lucide-react";
import { IconPicker, ICON_MAP } from "./IconPicker";
import { MODELS } from "./ModelPicker";
import { THINKING_CONFIGS, PERMISSION_MODES, EFFORT_LEVELS } from "./ControlBar";
import { ColorSwatchGrid } from "@/components/ui/ColorSwatchGrid";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
}

const DirInput: React.FC<DirInputProps> = ({ value, onChange, placeholder }) => (
  <div className="flex gap-1">
    <Input
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 text-sm flex-1"
    />
    <Button
      variant="outline"
      size="sm"
      className="h-8 px-2"
      onClick={async () => {
        const folder = await pickFolder(value || undefined);
        if (folder) onChange(folder);
      }}
      title="Browse..."
    >
      <FolderOpen className="w-3.5 h-3.5" />
    </Button>
  </div>
);

const TypeSelect: React.FC<{ value: string; onChange: (v: string) => void }> = ({
  value,
  onChange,
}) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger className="w-full h-8 text-sm">
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

const SessionDefaultsEditor: React.FC<{
  value: SessionDefaults;
  onChange: (v: SessionDefaults) => void;
}> = ({ value, onChange }) => (
  <div className="space-y-2 pt-2 border-t border-border">
    <p className="text-xs font-medium text-muted-foreground">Session Defaults</p>
    <div className="flex items-center gap-3">
      <label className="text-xs text-muted-foreground w-20 shrink-0">Model</label>
      <Select
        value={value.model ?? '__app_default__'}
        onValueChange={(v) => onChange({ ...value, model: v === '__app_default__' ? undefined : v })}
      >
        <SelectTrigger className="flex-1 h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__app_default__">App default</SelectItem>
          {MODELS.map((m) => (
            <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
    <div className="flex items-center gap-3">
      <label className="text-xs text-muted-foreground w-20 shrink-0">Thinking</label>
      <Select
        value={value.thinkingConfig ?? '__app_default__'}
        onValueChange={(v) => onChange({ ...value, thinkingConfig: (v === '__app_default__' ? undefined : v) as SessionDefaults['thinkingConfig'] })}
      >
        <SelectTrigger className="flex-1 h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__app_default__">App default</SelectItem>
          {THINKING_CONFIGS.map((c) => (
            <SelectItem key={c.id} value={c.id}>{c.name} — {c.description}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
    <div className="flex items-center gap-3">
      <label className="text-xs text-muted-foreground w-20 shrink-0">Effort</label>
      <Select
        value={value.effort ?? '__app_default__'}
        onValueChange={(v) => onChange({ ...value, effort: (v === '__app_default__' ? undefined : v) as SessionDefaults['effort'] })}
      >
        <SelectTrigger className="flex-1 h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__app_default__">App default</SelectItem>
          {EFFORT_LEVELS.map((l) => (
            <SelectItem key={l.id} value={l.id}>{l.name} — {l.description}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
    <div className="flex items-center gap-3">
      <label className="text-xs text-muted-foreground w-20 shrink-0">Permissions</label>
      <Select
        value={value.permissionMode ?? '__app_default__'}
        onValueChange={(v) => onChange({ ...value, permissionMode: v === '__app_default__' ? undefined : v })}
      >
        <SelectTrigger className="flex-1 h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__app_default__">App default</SelectItem>
          {PERMISSION_MODES.map((m) => (
            <SelectItem key={m.id} value={m.id}>{m.name} — {m.description}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  </div>
);

export const AccountSettings: React.FC = () => {
  const { refresh: refreshAccountsContext } = useAccounts();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [pathRules, setPathRules] = useState<PathRule[]>([]);
  const [overrides, setOverrides] = useState<Array<{project_path: string; account_id: number; account_name: string}>>([]);

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
  const [newCliPath, setNewCliPath] = useState<string>("");
  const [newCliPathError, setNewCliPathError] = useState<string | null>(null);
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
  const [editCliPathError, setEditCliPathError] = useState<string | null>(null);
  const [showEditIconPicker, setShowEditIconPicker] = useState(false);

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
    setEditCliPathError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const saveEdit = async () => {
    if (editingId === null || !editName.trim() || !editDir.trim()) return;
    // Validate cli_path before saving — empty/null is fine
    const trimmedCliPath = editCliPath.trim();
    if (trimmedCliPath) {
      const v = await api.validateCliPath(trimmedCliPath);
      if (!v.ok) {
        setEditCliPathError(v.error);
        return;
      }
    }
    try {
      const defaults = Object.keys(editSessionDefaults).length > 0 ? editSessionDefaults : null;
      const cliPath = trimmedCliPath || null;
      await api.updateAccount(editingId, editName.trim(), editDir.trim(), editType, editColor, editIcon, defaults, cliPath);
      setEditingId(null);
      setEditCliPathError(null);
      await loadData();
    } catch (error) {
      console.error("Failed to update account:", error);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim() || !newDir.trim()) return;
    const trimmedCliPath = newCliPath.trim();
    if (trimmedCliPath) {
      const v = await api.validateCliPath(trimmedCliPath);
      if (!v.ok) {
        setNewCliPathError(v.error);
        return;
      }
    }
    try {
      const defaults = Object.keys(newSessionDefaults).length > 0 ? newSessionDefaults : undefined;
      const cliPath = trimmedCliPath || null;
      await api.createAccount(newName.trim(), newDir.trim(), accounts.length === 0, newType, newColor, newIcon, defaults, cliPath);
      setNewName("");
      setNewDir("");
      setNewType("pro");
      setNewColor("#3b82f6");
      setNewIcon("user");
      setNewSessionDefaults({});
      setNewCliPath("");
      setNewCliPathError(null);
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
          {accounts.map((account) =>
            editingId === account.id ? (
              /* Edit mode */
              <div
                key={account.id}
                className="space-y-2 p-3 rounded-lg border border-primary/50 bg-primary/5"
              >
                <Input
                  placeholder="Account name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="h-8 text-sm"
                />
                <DirInput
                  value={editDir}
                  onChange={setEditDir}
                  placeholder="Config directory"
                />
                <TypeSelect value={editType} onChange={setEditType} />
                <div className="space-y-2">
                  <div className="flex items-start gap-3">
                    <label className="text-xs text-muted-foreground w-14 mt-1">Color</label>
                    <ColorSwatchGrid value={editColor} onChange={setEditColor} />
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-xs text-muted-foreground w-14">Icon</label>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setShowEditIconPicker(true)}
                      className="h-8 px-2"
                    >
                      {(() => {
                        const IconComponent = ICON_MAP[editIcon] || ICON_MAP.user;
                        return IconComponent ? <IconComponent className="w-4 h-4" /> : null;
                      })()}
                      <span className="ml-2 text-xs">{editIcon}</span>
                    </Button>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-xs text-muted-foreground w-14">Preview</label>
                    <div className="flex items-center gap-2">
                      <AccountBadge
                        name={editName || "Account"}
                        color={editColor}
                        icon={editIcon}
                        variant="compact"
                      />
                      <span className="text-xs text-foreground">{editName || "Account"}</span>
                    </div>
                  </div>
                </div>
                <SessionDefaultsEditor value={editSessionDefaults} onChange={setEditSessionDefaults} />
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">CLI path (optional)</label>
                  <Input
                    placeholder="(default: claude on PATH)"
                    value={editCliPath}
                    onChange={(e) => {
                      setEditCliPath(e.target.value);
                      setEditCliPathError(null);
                    }}
                    className="h-8 text-sm font-mono"
                  />
                  {editCliPathError && (
                    <div className="text-[11px] text-red-400">{editCliPathError}</div>
                  )}
                  <div className="text-[11px] text-muted-foreground">
                    Override which <code>claude</code> binary or wrapper to spawn.
                    Shell aliases (<code>claude-personal</code>) are not supported —
                    paste the resolved path (e.g. <code>~/.local/bin/claude</code>).
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={saveEdit} className="h-7 text-xs">
                    <Check className="w-3 h-3 mr-1" />
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={cancelEdit}
                    className="h-7 text-xs"
                  >
                    <X className="w-3 h-3 mr-1" />
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              /* Display mode */
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
                  onClick={() => startEdit(account)}
                  title="Edit"
                >
                  <Pencil className="w-3 h-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => handleDelete(account.id)}
                  title="Delete"
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            )
          )}
        </div>

        {showAddAccount ? (
          <div className="mt-3 space-y-2 p-3 rounded-lg border border-dashed border-border">
            <Input
              placeholder="Account name (e.g., personal)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
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
                  onClick={() => setShowNewIconPicker(true)}
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
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">CLI path (optional)</label>
              <Input
                placeholder="(default: claude on PATH)"
                value={newCliPath}
                onChange={(e) => {
                  setNewCliPath(e.target.value);
                  setNewCliPathError(null);
                }}
                className="h-8 text-sm font-mono"
              />
              {newCliPathError && (
                <div className="text-[11px] text-red-400">{newCliPathError}</div>
              )}
              <div className="text-[11px] text-muted-foreground">
                Override which <code>claude</code> binary or wrapper to spawn.
                Shell aliases (<code>claude-personal</code>) are not supported —
                paste the resolved path (e.g. <code>~/.local/bin/claude</code>).
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleCreate} className="h-7 text-xs">
                Add
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowAddAccount(false)}
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
            onClick={() => setShowAddAccount(true)}
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
                onClick={() => handleRemoveRule(rule.id)}
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
              onValueChange={(v) => setNewRuleAccountId(v ? Number(v) : null)}
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
              <Button size="sm" onClick={handleAddRule} className="h-7 text-xs" disabled={!newRulePrefix.trim() || newRuleAccountId === null}>
                Add
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowAddRule(false)}
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
            onClick={() => setShowAddRule(true)}
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
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTestPath(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent) => e.key === "Enter" && handleTestResolution()}
            placeholder="/Users/you/Repos/project-name"
            className="font-mono text-sm"
          />
          <Button onClick={handleTestResolution} size="sm" variant="outline">
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
        onClose={() => setShowEditIconPicker(false)}
      />
      <IconPicker
        value={newIcon}
        onSelect={setNewIcon}
        isOpen={showNewIconPicker}
        onClose={() => setShowNewIconPicker(false)}
      />
    </div>
  );
};
