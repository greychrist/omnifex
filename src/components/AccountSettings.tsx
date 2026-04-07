import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type Account, type PathRule } from "@/lib/api";
import { AccountBadge } from "@/components/AccountBadge";
import { Trash2, Plus, Star } from "lucide-react";

export const AccountSettings: React.FC = () => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [pathRules, setPathRules] = useState<PathRule[]>([]);
  const [newAccountName, setNewAccountName] = useState("");
  const [newAccountDir, setNewAccountDir] = useState("");
  const [newRulePrefix, setNewRulePrefix] = useState("");
  const [newRuleAccountId, setNewRuleAccountId] = useState<number | null>(null);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showAddRule, setShowAddRule] = useState(false);

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

  const handleCreateAccount = async () => {
    if (!newAccountName.trim() || !newAccountDir.trim()) return;
    try {
      await api.createAccount(newAccountName.trim(), newAccountDir.trim(), accounts.length === 0);
      setNewAccountName("");
      setNewAccountDir("");
      setShowAddAccount(false);
      await loadData();
    } catch (error) {
      console.error("Failed to create account:", error);
    }
  };

  const handleDeleteAccount = async (id: number) => {
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
      <div>
        <h3 className="text-sm font-semibold mb-3">Accounts</h3>
        <div className="space-y-2">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-muted/30"
            >
              <AccountBadge name={account.name} />
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
                className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => handleDeleteAccount(account.id)}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>

        {showAddAccount ? (
          <div className="mt-3 space-y-2 p-3 rounded-lg border border-dashed border-border">
            <Input
              placeholder="Account name (e.g., personal)"
              value={newAccountName}
              onChange={(e) => setNewAccountName(e.target.value)}
              className="h-8 text-sm"
            />
            <Input
              placeholder="Config directory (e.g., ~/.claude-personal)"
              value={newAccountDir}
              onChange={(e) => setNewAccountDir(e.target.value)}
              className="h-8 text-sm"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleCreateAccount} className="h-7 text-xs">
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
            <Input
              placeholder="Path prefix (e.g., ~/Repos/personal/)"
              value={newRulePrefix}
              onChange={(e) => setNewRulePrefix(e.target.value)}
              className="h-8 text-sm"
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
