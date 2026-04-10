import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type Account, type PathRule } from "@/lib/api";
import { AccountBadge } from "@/components/AccountBadge";
import { useAccounts } from "@/contexts/AccountsContext";
import { Trash2, Plus, Pencil, FolderOpen, Check, X } from "lucide-react";

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
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className="w-full h-8 text-sm rounded-md border border-border bg-background px-3"
  >
    {ACCOUNT_TYPES.map((t) => (
      <option key={t.value} value={t.value}>
        {t.label} ({t.desc})
      </option>
    ))}
  </select>
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

  // Edit account state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editDir, setEditDir] = useState("");
  const [editType, setEditType] = useState("");
  const [editColor, setEditColor] = useState("#3b82f6");

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
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const saveEdit = async () => {
    if (editingId === null || !editName.trim() || !editDir.trim()) return;
    try {
      await api.updateAccount(editingId, editName.trim(), editDir.trim(), editType, editColor);
      setEditingId(null);
      await loadData();
    } catch (error) {
      console.error("Failed to update account:", error);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim() || !newDir.trim()) return;
    try {
      await api.createAccount(newName.trim(), newDir.trim(), accounts.length === 0, newType, newColor);
      setNewName("");
      setNewDir("");
      setNewType("pro");
      setNewColor("#3b82f6");
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
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground">Color</label>
                  <input
                    type="color"
                    value={editColor}
                    onChange={(e) => setEditColor(e.target.value)}
                    className="w-8 h-8 rounded cursor-pointer border border-border bg-transparent"
                  />
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
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">Color</label>
              <input
                type="color"
                value={newColor}
                onChange={(e) => setNewColor(e.target.value)}
                className="w-8 h-8 rounded cursor-pointer border border-border bg-transparent"
              />
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
            <select
              value={newRuleAccountId ?? ""}
              onChange={(e) => setNewRuleAccountId(Number(e.target.value) || null)}
              className="w-full h-8 text-sm rounded-md border border-border bg-background px-3"
            >
              <option value="">Select account...</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
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
    </div>
  );
};
