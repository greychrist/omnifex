import React, { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  api,
  type Account,
  type AccountEngine,
  type PathRule,
} from "@/lib/api";
import { AccountBadge } from "@/components/AccountBadge";
import { useAccounts } from "@/contexts/AccountsContext";
import { Trash2, Plus, Pencil, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";
import {
  AccountDialog,
  type AccountDialogSavePayload,
} from "@/components/AccountDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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

const DirInput: React.FC<DirInputProps> = ({ value, onChange, placeholder }) => {
  return (
    <div className="flex gap-1">
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); }}
        className="h-8 text-sm flex-1"
      />
      <Button
        variant="outline"
        size="sm"
        className="h-8 px-2"
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

/**
 * Tiny engine label chip used in the account list and the path-rule
 * account dropdown so Claude vs Codex accounts are distinguishable at a
 * glance. Color-coded but intentionally low-key — it sits next to the
 * account badge, not in place of it.
 */
const EnginePill: React.FC<{ engine: AccountEngine }> = ({ engine }) => (
  <span
    className={cn(
      "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
      engine === "codex"
        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
        : "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    )}
  >
    {engine === "codex" ? "Codex" : "Claude"}
  </span>
);

export const AccountSettings: React.FC = () => {
  const { refresh: refreshAccountsContext } = useAccounts();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [pathRules, setPathRules] = useState<PathRule[]>([]);
  const [overrides, setOverrides] = useState<{project_path: string; account_id: number; account_name: string}[]>([]);

  // Test resolution state
  const [testPath, setTestPath] = useState("");
  const [testResult, setTestResult] = useState<{
    account: { name: string; subscription_label: string; config_dir: string; color?: string | null };
    match_type: string;
    match_detail: string;
  } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  // Inline status for the "Scan for accounts" escape-hatch button. Cleared
  // automatically the next time the button is clicked.
  const [scanStatus, setScanStatus] = useState<{ kind: 'info' | 'success' | 'error'; message: string } | null>(null);

  // Add/Edit account dialog state. `null` mode = dialog closed.
  const [dialogMode, setDialogMode] = useState<'add' | 'edit' | null>(null);
  const [dialogAccount, setDialogAccount] = useState<Account | undefined>(undefined);

  // Add rule form
  const [showAddRule, setShowAddRule] = useState(false);
  const [newRulePrefix, setNewRulePrefix] = useState("");
  const [newRuleAccountId, setNewRuleAccountId] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [accts, rules] = await Promise.all([
        api.listAccounts(),
        api.listPathRules(),
      ]);
      setAccounts(accts);
      setPathRules(rules);
      logAndForget('account-settings:refresh-accounts-context', refreshAccountsContext());
    } catch (error) {
      console.error("Failed to load account data:", error);
    }
  }, [refreshAccountsContext]);

  useEffect(() => {
    logAndForget('account-settings:load-data', loadData());
    api.listProjectOverrides().then(setOverrides).catch(console.error);
  }, [loadData]);

  const handleTestResolution = async () => {
    if (!testPath.trim()) return;
    setTestError(null);
    setTestResult(null);
    try {
      const result = await api.explainAccountResolution(testPath.trim());
      if (result) {
        setTestResult({
          account: {
            name: result.account.name,
            subscription_label: result.account.subscription_label,
            config_dir: result.account.config_dir,
            color: result.account.color,
          },
          match_type: result.match_type,
          match_detail: result.match_detail,
        });
      } else {
        setTestError("No account would be resolved for this path");
      }
    } catch (err) {
      setTestError(String(err));
    }
  };

  const openAdd = () => {
    setDialogAccount(undefined);
    setDialogMode('add');
  };

  const openEdit = (account: Account) => {
    setDialogAccount(account);
    setDialogMode('edit');
  };

  const closeDialog = () => {
    setDialogMode(null);
    setDialogAccount(undefined);
  };

  const handleDialogSave = async (payload: AccountDialogSavePayload) => {
    try {
      if (dialogMode === 'edit' && dialogAccount) {
        await api.updateAccount(dialogAccount.id, {
          name: payload.name,
          configDir: payload.configDir,
          subscriptionLabel: payload.subscriptionLabel,
          hasCost: payload.hasCost,
          color: payload.color,
          icon: payload.icon,
          sessionDefaults: payload.sessionDefaults ?? null,
        });
      } else {
        await api.createAccount({
          name: payload.name,
          configDir: payload.configDir,
          engine: payload.engine,
          subscriptionLabel: payload.subscriptionLabel,
          hasCost: payload.hasCost,
          color: payload.color,
          icon: payload.icon,
          sessionDefaults: payload.sessionDefaults,
        });
      }
      closeDialog();
      await loadData();
    } catch (error) {
      console.error("Failed to save account:", error);
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
      {/* Accounts — Claude and Codex unified into one list. */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Accounts</h3>
        <div className="space-y-2">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-muted/30"
            >
              <AccountBadge name={account.name} color={account.color} />
              <EnginePill engine={account.engine} />
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                {account.subscription_label}
              </span>
              {!account.has_cost && (
                <span className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wide">
                  no cost
                </span>
              )}
              <span className="text-xs text-muted-foreground flex-1 truncate">
                {account.config_dir}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground"
                onClick={() => { openEdit(account); }}
                title="Edit"
                aria-label={`Edit ${account.name}`}
              >
                <Pencil className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={fireAndLog('account-settings:click', () => handleDelete(account.id))}
                title="Delete"
                aria-label={`Delete ${account.name}`}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>

        <div className="mt-2 flex items-center gap-3">
          <Button
            variant="link"
            size="sm"
            className="h-6 px-0 text-xs"
            onClick={openAdd}
          >
            <Plus className="w-3 h-3 mr-1" />
            Add account
          </Button>
          <Button
            variant="link"
            size="sm"
            className="h-6 px-0 text-xs"
            onClick={fireAndLog('account-settings:click', async () => {
              setScanStatus(null);
              try {
                const created = await api.scanForNewAccounts();
                if (created.length === 0) {
                  setScanStatus({
                    kind: 'info',
                    message: 'No new config directories found.',
                  });
                } else {
                  const names = created.map((a) => a.name).join(', ');
                  setScanStatus({
                    kind: 'success',
                    message: `Added ${created.length} account${created.length === 1 ? '' : 's'}: ${names}`,
                  });
                  await loadData();
                }
              } catch (err) {
                console.error('scanForNewAccounts failed:', err);
                setScanStatus({ kind: 'error', message: 'Scan failed. See console for details.' });
              }
            })}
          >
            Scan for accounts
          </Button>
        </div>
        {scanStatus && (
          <p
            className={cn(
              'mt-2 text-xs',
              scanStatus.kind === 'success' && 'text-emerald-600 dark:text-emerald-400',
              scanStatus.kind === 'error' && 'text-destructive',
              scanStatus.kind === 'info' && 'text-muted-foreground',
            )}
          >
            {scanStatus.message}
          </p>
        )}
      </div>

      {/* Add / Edit account dialog. Mounted once at panel level; opens when
          openAdd()/openEdit() set dialogMode. Engine selection + Codex
          sign-in now live inside AccountDialog. */}
      {dialogMode !== null && (
        <AccountDialog
          mode={dialogMode}
          account={dialogMode === 'edit' ? dialogAccount : undefined}
          open={true}
          onClose={closeDialog}
          onSave={fireAndLog('account-settings:account-save', handleDialogSave)}
        />
      )}

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
              <EnginePill engine={rule.account_engine} />
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
                    <span className="flex items-center gap-2">
                      <EnginePill engine={a.engine} />
                      {a.name}
                    </span>
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
              <span className="text-foreground/50">({testResult.account.subscription_label})</span>
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
