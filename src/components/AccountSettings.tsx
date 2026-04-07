import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type Account, type PathRule } from "@/lib/api";
import { AccountBadge } from "@/components/AccountBadge";
import { Trash2, Plus, Star, Pencil, FolderOpen, Check, X } from "lucide-react";

const ACCOUNT_TYPES = [
  { value: "max", label: "Max", desc: "No cost, usage limits only" },
  { value: "enterprise", label: "Enterprise", desc: "Has cost" },
  { value: "pro", label: "Pro", desc: "Has cost" },
  { value: "free", label: "Free", desc: "Has cost" },
];

async function pickFolder(defaultPath?: string): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Folder",
      defaultPath: defaultPath || (await api.getHomeDirectory()),
    });
    return typeof selected === "string" ? selected : null;
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
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [pathRules, setPathRules] = useState<PathRule[]>([]);

  // Add account form
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDir, setNewDir] = useState("");
  const [newType, setNewType] = useState("pro");

  // Edit account state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editDir, setEditDir] = useState("");
  const [editType, setEditType] = useState("");

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
    } catch (error) {
      console.error("Failed to load account data:", error);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const startEdit = (account: Account) => {
    setEditingId(account.id);
    setEditName(account.name);
    setEditDir(account.config_dir);
    setEditType(account.account_type);
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const saveEdit = async () => {
    if (editingId === null || !editName.trim() || !editDir.trim()) return;
    try {
      await api.updateAccount(editingId, editName.trim(), editDir.trim(), editType);
      setEditingId(null);
      await loadData();
    } catch (error) {
      console.error("Failed to update account:", error);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim() || !newDir.trim()) return;
    try {
      await api.createAccount(newName.trim(), newDir.trim(), accounts.length === 0, newType);
      setNewName("");
      setNewDir("");
      setNewType("pro");
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

  const handleSetDefault = async (id: number) => {
    try {
      await api.setDefaultAccount(id);
      await loadData();
    } catch (error) {
      console.error("Failed to set default:", error);
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
                <AccountBadge name={account.name} />
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                  {account.account_type}
                </span>
                <span className="text-xs text-muted-foreground flex-1 truncate">
                  {account.config_dir}
                </span>
                {account.is_default && (
                  <span className="text-[10px] font-medium text-emerald-400">DEFAULT</span>
                )}
                {!account.is_default && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-muted-foreground"
                    onClick={() => handleSetDefault(account.id)}
                    title="Set as default"
                  >
                    <Star className="w-3 h-3" />
                  </Button>
                )}
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
              <AccountBadge name={rule.account_name} />
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
              <Button size="sm" onClick={handleAddRule} className="h-7 text-xs">
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
    </div>
  );
};
